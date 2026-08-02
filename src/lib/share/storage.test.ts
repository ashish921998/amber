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
    const result = reconcileSession(store, BATCH_A, id);
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
    const first = reconcileSession(store, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    // Simulate a saved entry before the remount.
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });

    const result = reconcileSession(store, BATCH_A, id);
    expect(result.kind).toBe("resume");
    if (result.kind !== "resume") return;
    expect(result.session.entries[0].status).toBe("saved");
    expect(result.session.entries[0].itemId).toBe("items-1");
  });

  it("clears native payloads for a matching completed session then deletes the record", () => {
    const store = memoryStore();
    reconcileSession(store, BATCH_A, id);
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });
    markComplete(store);

    // The completed session is reconciled once: it directs a clear and is gone.
    const result = reconcileSession(store, BATCH_A, id);
    expect(result.kind).toBe("clear");
    expect(loadSession(store)).toBeNull();
  });

  it("starts a fresh session when a later re-share matches a stale completed record", () => {
    // Completed state is single-use: after reconcile cleared it above, an
    // identical-content re-share must start a NEW session, not be dropped.
    const store = memoryStore();
    reconcileSession(store, BATCH_A, id);
    updateEntry(store, 0, { status: "saved", itemId: "items-1", kind: "link" });
    markComplete(store);
    reconcileSession(store, BATCH_A, id); // consumes the completed record
    expect(loadSession(store)).toBeNull();

    // A deliberate later re-share of identical content is a fresh session.
    const result = reconcileSession(store, BATCH_A_DUP, id);
    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.session.entries[0].status).toBe("pending");
  });

  it("starts a new session when the fingerprint differs", () => {
    const store = memoryStore();
    const first = reconcileSession(store, BATCH_A, id);
    if (first.kind !== "new") throw new Error("expected new");
    const oldSessionId = first.session.sessionId;

    const result = reconcileSession(store, BATCH_B, () => "sess-2");
    expect(result.kind).toBe("new");
    if (result.kind !== "new") return;
    expect(result.session.sessionId).not.toBe(oldSessionId);
  });

  it("drops stale local state when there are no raw payloads", () => {
    const store = memoryStore();
    reconcileSession(store, BATCH_A, id);
    expect(loadSession(store)).not.toBeNull();

    const result = reconcileSession(store, [], id);
    expect(result.kind).toBe("empty");
    expect(loadSession(store)).toBeNull();
  });

  it("assigns distinct stable operation ids to duplicate entries in one batch", () => {
    // Two identical entries must each get their own id by raw index.
    const store = memoryStore();
    const result = reconcileSession(store, [payload("x"), payload("x")], id);
    if (result.kind !== "new") throw new Error("expected new");
    const ids = result.session.entries.map((e) => e.operationId);
    expect(ids).toEqual(["share:sess-1:0", "share:sess-1:1"]);
  });

  it("round-trips through the store with the current schema version", () => {
    const store = memoryStore();
    reconcileSession(store, BATCH_A, id);
    const session = loadSession(store);
    expect(session?.version).toBe(SESSION_SCHEMA_VERSION);
  });
});

describe("loadSession", () => {
  it("drops an incompatible (future) schema version rather than misinterpreting it", () => {
    const store = memoryStore();
    store.set("incoming-share-session", JSON.stringify({ version: 999 }));
    expect(loadSession(store)).toBeNull();
    // The corrupt record was removed so the next reconcile starts clean.
    expect(store.contains("incoming-share-session")).toBe(false);
  });

  it("drops unparseable JSON", () => {
    const store = memoryStore();
    store.set("incoming-share-session", "{not json");
    expect(loadSession(store)).toBeNull();
  });

  it("drops a session missing required fields", () => {
    const store = memoryStore();
    store.set("incoming-share-session", JSON.stringify({ version: 1 }));
    expect(loadSession(store)).toBeNull();
  });
});

describe("markComplete", () => {
  it("is idempotent", () => {
    const store = memoryStore();
    reconcileSession(store, BATCH_A, id);
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
    reconcileSession(store, BATCH_A, id);
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
    reconcileSession(store, [payload("a"), payload("b"), payload("c")], id);
    updateEntry(store, 0, { status: "saved" });
    updateEntry(store, 1, { status: "failed" });
    // index 2 still pending
    const session = loadSession(store)!;
    const toProcess = entriesToProcess(session);
    expect(toProcess.map((e) => e.index)).toEqual([1, 2]);
  });

  it("reports settled only when nothing is pending or failed", () => {
    const store = memoryStore();
    reconcileSession(store, [payload("a"), payload("b")], id);
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
    reconcileSession(store, BATCH_A, id);
    deleteSession(store);
    expect(loadSession(store)).toBeNull();
  });
});
