// Tests for the incoming-share session store. The reconciliation rules are the
// load-bearing correctness logic for plan 004, so every remount window is
// exercised with an in-memory adapter — no MMKV, no React Native runtime.
import { describe, expect, it } from "vitest";

import {
  allEntriesSettled,
  deleteSession,
  entriesToProcess,
  fingerprint,
  loadSession,
  markComplete,
  operationIdFor,
  reconcileSession,
  SESSION_KEY,
  SESSION_SCHEMA_VERSION,
  updateEntry,
  type SessionStoreAdapter,
  type RawSharePayload,
} from "./storage";

/** A minimal in-memory MMKV-shaped adapter backed by a Map. `contains` is
 * modeled because the module never calls it, but the interface requires it. */
function memoryStore(): SessionStoreAdapter {
  const map = new Map<string, string>();
  return {
    getString: (k) => map.get(k),
    set: (k, v) => {
      map.set(k, v);
    },
    remove: (k) => {
      map.delete(k);
    },
    contains: (k) => map.has(k),
  };
}

// The authenticated user the session is scoped to. Different USER values model
// different accounts on the same device.
const USER = "user-a";

const id = () => "sess-1";
const payload = (value: string, shareType = "text"): RawSharePayload => ({
  value,
  shareType,
});

const BATCH_A = [payload("https://a.example", "url")];
const BATCH_A_DUP = [payload("https://a.example", "url")]; // identical content
const BATCH_B = [payload("https://b.example", "url")]; // different content

describe("fingerprint", () => {
  it("encodes order and duplicates so identical-content distinct batches stay distinct", () => {
    // Two identical entries in one batch must NOT collapse with one entry.
    expect(fingerprint([payload("x"), payload("x")])).not.toBe(fingerprint([payload("x")]));
    // Order matters: a re-ordering is a different batch.
    expect(fingerprint([payload("a"), payload("b")])).not.toBe(
      fingerprint([payload("b"), payload("a")]),
    );
    // Same batch, same fingerprint (deterministic).
    expect(fingerprint([payload("a"), payload("b")])).toBe(
      fingerprint([payload("a"), payload("b")]),
    );
  });

  it("includes mimeType and shareType so they distinguish otherwise-equal values", () => {
    expect(fingerprint([payload("x", "text")])).not.toBe(
      fingerprint([{ value: "x", shareType: "url" }]),
    );
    expect(fingerprint([payload("x")])).not.toBe(
      fingerprint([{ value: "x", shareType: "text", mimeType: "text/plain" }]),
    );
  });

  it("treats undefined and omitted mimeType identically (no flapping)", () => {
    expect(fingerprint([{ value: "x", shareType: "text" }])).toBe(
      fingerprint([{ value: "x", shareType: "text", mimeType: undefined }]),
    );
  });

  it("never collides via delimiter concatenation", () => {
    // The classic delimiter pitfall: ["a|b"] vs ["a","b"].
    expect(fingerprint([payload("a|b")])).not.toBe(
      fingerprint([payload("a"), payload("b")]),
    );
  });
});

describe("operationIdFor", () => {
  it("embeds the session id and the raw index", () => {
    expect(operationIdFor("sess-1", 0)).toBe("share:sess-1:0");
    expect(operationIdFor("sess-1", 7)).toBe("share:sess-1:7");
  });
});

describe("reconcileSession", () => {
  it("starts a new active session for a fresh batch", () => {
    const store = memoryStore();
    const result = reconcileSession(store, USER, BATCH_A, id);
    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.session.phase).toBe("active");
    expect(result.session.sessionId).toBe("sess-1");
    expect(result.session.entries).toHaveLength(1);
    expect(result.session.entries[0].operationId).toBe("share:sess-1:0");
    expect(result.session.entries[0].status).toBe("pending");
    // Persisted.
    expect(loadSession(store)?.fingerprint).toBe(fingerprint(BATCH_A));
  });

  it("resumes an active session with the same fingerprint (does not reset entries)", () => {
    const store = memoryStore();
    const first = reconcileSession(store, USER, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    // Simulate a saved entry before the remount.
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });

    const result = reconcileSession(store, USER, BATCH_A, id);
    expect(result.kind).toBe("resume");
    if (result.kind !== "resume") return;
    expect(result.session.entries[0].status).toBe("saved");
    expect(result.session.entries[0].itemId).toBe("items-1");
  });

  it("directs a clear for a matching completed session but KEEPS the record until clear succeeds", () => {
    // The throwing-clear invariant: reconcileSession must NOT delete the
    // completed session. If it did, a throwing native clear on remount would
    // leave native payloads with no session, and the next remount would treat
    // the batch as new and re-save everything (duplicates). The caller owns the
    // delete, only after a non-throwing clear.
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });
    markComplete(store);

    const result = reconcileSession(store, USER, BATCH_A, id);
    expect(result.kind).toBe("clear");
    // Record is intentionally retained: a failed clear must be retryable.
    expect(loadSession(store)).not.toBeNull();
    expect(loadSession(store)?.phase).toBe("complete");

    // The caller deletes only after the native clear succeeds.
    deleteSession(store);
    expect(loadSession(store)).toBeNull();
  });

  it("starts a fresh session when a later re-share matches a stale completed record", () => {
    // Completed state is single-use: after the caller cleared and deleted, an
    // identical-content re-share must start a NEW session, not be dropped.
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });
    markComplete(store);
    reconcileSession(store, USER, BATCH_A, id); // directs a clear (record retained)
    deleteSession(store); // caller deletes after a successful clear
    expect(loadSession(store)).toBeNull();

    // A deliberate later re-share of identical content is a fresh session.
    const result = reconcileSession(store, USER, BATCH_A_DUP, id);
    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.session.entries[0].status).toBe("pending");
  });

  it("keeps directing a clear on repeated remounts until the caller deletes (throwing-clear safety)", () => {
    // The throwing-clear invariant in full: if the native clear keeps failing,
    // reconcileSession must keep returning 'clear' with the completed record
    // intact, so every remount retries the clear rather than starting a new
    // session that would re-save everything (duplicates).
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });
    markComplete(store);

    // First remount: clear fails (caller does NOT delete).
    let result = reconcileSession(store, USER, BATCH_A, id);
    expect(result.kind).toBe("clear");
    expect(loadSession(store)?.phase).toBe("complete");

    // Second remount: clear still failing — still 'clear', record still there.
    result = reconcileSession(store, USER, BATCH_A, id);
    expect(result.kind).toBe("clear");
    expect(loadSession(store)?.phase).toBe("complete");

    // Third remount: clear finally succeeds, caller deletes — record is gone.
    result = reconcileSession(store, USER, BATCH_A, id);
    expect(result.kind).toBe("clear");
    deleteSession(store);
    expect(loadSession(store)).toBeNull();
  });

  it("starts a new session when the fingerprint differs", () => {
    const store = memoryStore();
    const first = reconcileSession(store, USER, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    const oldSessionId = first.session.sessionId;

    const result = reconcileSession(store, USER, BATCH_B, () => "sess-2");
    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.session.sessionId).not.toBe(oldSessionId);
  });

  it("drops stale local state when there are no raw payloads", () => {
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    expect(loadSession(store)).not.toBeNull();

    const result = reconcileSession(store, USER, [], id);
    expect(result.kind).toBe("empty");
    expect(loadSession(store)).toBeNull();
  });

  it("assigns distinct stable operation ids to duplicate entries in one batch", () => {
    // Two identical entries must each get their own id by raw index.
    const store = memoryStore();
    const result = reconcileSession(store, USER, [payload("x"), payload("x")], id);
    if (result.kind !== "new") throw new Error("expected new");
    const ids = result.session.entries.map((e) => e.operationId);
    expect(ids).toEqual(["share:sess-1:0", "share:sess-1:1"]);
  });

  it("round-trips through the store with the current schema version", () => {
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    const session = loadSession(store);
    expect(session?.version).toBe(SESSION_SCHEMA_VERSION);
  });
});

describe("loadSession", () => {
  it("drops an incompatible (future) schema version rather than misinterpreting it", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({ version: 999 }));
    expect(loadSession(store)).toBeNull();
    // The corrupt record was removed so the next reconcile starts clean.
    expect(store.contains(SESSION_KEY)).toBe(false);
  });

  it("drops unparseable JSON", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, "{not json");
    expect(loadSession(store)).toBeNull();
  });

  it("drops a session missing required fields", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({ version: 1 }));
    expect(loadSession(store)).toBeNull();
  });
});

describe("markComplete", () => {
  it("is idempotent", () => {
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    markComplete(store);
    markComplete(store);
    expect(loadSession(store)?.phase).toBe("complete");
  });

  it("is a no-op when no session exists", () => {
    const store = memoryStore();
    expect(() => markComplete(store)).not.toThrow();
    expect(loadSession(store)).toBeNull();
  });
});

describe("updateEntry", () => {
  it("applies a partial patch to the entry at the given index", () => {
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    updateEntry(store, 0, { status: "failed", kind: "image", message: "upload down" });
    const entry = loadSession(store)?.entries[0];
    expect(entry?.status).toBe("failed");
    expect(entry?.kind).toBe("image");
    expect(entry?.message).toBe("upload down");
  });

  it("is a no-op when the session or index is absent", () => {
    const store = memoryStore();
    expect(() => updateEntry(store, 0, { status: "saved" })).not.toThrow();
  });
});

describe("entriesToProcess / allEntriesSettled", () => {
  it("selects only pending and failed entries", () => {
    const store = memoryStore();
    reconcileSession(store, USER, [payload("a"), payload("b"), payload("c")], id);
    updateEntry(store, 0, { status: "saved" });
    updateEntry(store, 1, { status: "failed" });
    // index 2 still pending
    const session = loadSession(store)!;
    const toProcess = entriesToProcess(session);
    expect(toProcess.map((e) => e.index)).toEqual([1, 2]);
  });

  it("reports settled only when nothing is pending or failed", () => {
    const store = memoryStore();
    reconcileSession(store, USER, [payload("a"), payload("b")], id);
    expect(allEntriesSettled(loadSession(store)!)).toBe(false);
    updateEntry(store, 0, { status: "saved" });
    expect(allEntriesSettled(loadSession(store)!)).toBe(false);
    updateEntry(store, 1, { status: "unsupported" });
    expect(allEntriesSettled(loadSession(store)!)).toBe(true);
  });
});

describe("deleteSession", () => {
  it("removes the persisted record", () => {
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    deleteSession(store);
    expect(loadSession(store)).toBeNull();
  });

  it("is a no-op against a different session id (scoped delete)", () => {
    // An in-flight run finishing after a newer session replaced its record must
    // not delete the newer session.
    const store = memoryStore();
    const first = reconcileSession(store, USER, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    const firstSessionId = first.session.sessionId;

    // A different batch replaces the record with a new session.
    const second = reconcileSession(store, USER, BATCH_B, () => "sess-2");
    if (second.kind !== "new") throw new Error("expected new");

    // The old session tries to delete by its (now-stale) id — must be a no-op.
    deleteSession(store, firstSessionId);
    expect(loadSession(store)?.sessionId).toBe("sess-2");
  });
});

describe("user-scoped sessions (account switching)", () => {
  it("starts a fresh session when a different user reconciles an identical batch", () => {
    // user-a completes a batch; user-b (same device) sharing the SAME content
    // must NOT match user-a's stale record — otherwise the new share is dropped.
    const store = memoryStore();
    const a = reconcileSession(store, USER, BATCH_A, id);
    if (a.kind !== "new") throw new Error("expected new");
    updateEntry(store, 0, { status: "saved", itemId: "items-a", kind: "link" });
    markComplete(store);

    // user-b reconciles identical content: must be a NEW session, not a clear.
    const result = reconcileSession(store, "user-b", BATCH_A_DUP, () => "sess-b");
    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.session.userId).toBe("user-b");
    expect(result.session.sessionId).toBe("sess-b");
  });

  it("does not match a different user's completed session (no silent drop)", () => {
    const store = memoryStore();
    reconcileSession(store, USER, BATCH_A, id);
    updateEntry(store, 0, { status: "saved", itemId: "items-a", kind: "link" });
    markComplete(store);

    // user-b: identical content. The completed record belongs to user-a, so it
    // is replaced (newSession overwrites). The return is 'new', never 'clear'.
    const result = reconcileSession(store, "user-b", BATCH_A, () => "sess-b");
    expect(result.kind).not.toBe("clear");
    expect(result.kind).toBe("new");
    // The record now belongs to user-b.
    expect(loadSession(store)?.userId).toBe("user-b");
  });
});

describe("entry validation in loadSession", () => {
  it("drops a session containing a malformed entry ({}) instead of trusting it", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      fingerprint: "fp",
      userId: USER,
      sessionId: "sess-x",
      phase: "active",
      entries: [{}],
    }));
    expect(loadSession(store)).toBeNull();
    expect(store.contains(SESSION_KEY)).toBe(false);
  });

  it("drops a session whose entry has an out-of-set status", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      fingerprint: "fp",
      userId: USER,
      sessionId: "sess-x",
      phase: "active",
      entries: [
        { index: 0, operationId: "share:sess-x:0", kind: "link", status: "bogus" },
      ],
    }));
    expect(loadSession(store)).toBeNull();
  });

  it("drops a session whose entry has a kind outside ENTRY_KINDS", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      fingerprint: "fp",
      userId: USER,
      sessionId: "sess-x",
      phase: "active",
      entries: [
        { index: 0, operationId: "share:sess-x:0", kind: "garbage", status: "pending" },
      ],
    }));
    expect(loadSession(store)).toBeNull();
  });

  it("drops a session whose entry has a non-integer index", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      fingerprint: "fp",
      userId: USER,
      sessionId: "sess-x",
      phase: "active",
      entries: [
        { index: 1.5, operationId: "share:sess-x:0", kind: "link", status: "pending" },
      ],
    }));
    expect(loadSession(store)).toBeNull();
  });

  it("drops a session whose entry has an empty operationId", () => {
    const store = memoryStore();
    store.set(SESSION_KEY, JSON.stringify({
      version: SESSION_SCHEMA_VERSION,
      fingerprint: "fp",
      userId: USER,
      sessionId: "sess-x",
      phase: "active",
      entries: [
        { index: 0, operationId: "", kind: "link", status: "pending" },
      ],
    }));
    expect(loadSession(store)).toBeNull();
  });
});

describe("session-scoped mutations (new-share-during-in-flight-run safety)", () => {
  it("updateEntry is a no-op when sessionId does not match", () => {
    // The in-flight run's persistEntry must not touch a newer session's entry.
    const store = memoryStore();
    const first = reconcileSession(store, USER, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    const firstSessionId = first.session.sessionId;

    // A new batch replaces the record.
    reconcileSession(store, USER, BATCH_B, () => "sess-2");

    // The old run tries to update entry index 0 by its stale session id.
    updateEntry(store, 0, { status: "saved", kind: "link" }, firstSessionId);
    // The new session's entry 0 is untouched.
    const live = loadSession(store);
    expect(live?.sessionId).toBe("sess-2");
    expect(live?.entries[0].status).toBe("pending");
  });

  it("markComplete is a no-op when sessionId does not match", () => {
    const store = memoryStore();
    const first = reconcileSession(store, USER, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    const firstSessionId = first.session.sessionId;

    reconcileSession(store, USER, BATCH_B, () => "sess-2");
    markComplete(store, firstSessionId);
    // The newer session stays active (not completed).
    expect(loadSession(store)?.phase).toBe("active");
  });
});
