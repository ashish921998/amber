// Tests for the pure share processor. No React/Convex/storage imports are
// exercised — save operations and persistence are fakes. Runs in the Node
// default env. The orchestration correctness (per-entry isolation, retry-only-
// failed, idempotent re-process) lives here.
import { describe, expect, it, vi } from "vitest";

import type { Id } from "@convex/_generated/dataModel";
import type { ImageSaveResult } from "@/lib/use-save-image";
import {
  classifyEntries,
  classifyPayload,
  processSession,
  type ResolvedPayload,
  type ShareSaveDeps,
} from "./process-share";
import { operationIdFor, type ShareEntry, type ShareSession } from "./storage";

// Stub the modules the processor imports via the `@/` alias so it loads under
// Node without the Metro path map. The processor consumes `isProbablyUrl` at
// runtime (classify) and the dataModel/use-save-image types at compile time
// only. Mirrors how use-save-image.test.ts mocks its alias modules. isProbablyUrl
// is re-exported from its real relative source so classification behavior is
// exercised against the actual helper, not a hand-rolled stub.
vi.mock("@/lib/url", async () => {
  const actual = await vi.importActual<{ isProbablyUrl: (t: string) => boolean }>("../url");
  return { isProbablyUrl: actual.isProbablyUrl };
});
vi.mock("@convex/_generated/dataModel", () => ({}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeSession(entryCount: number, sessionId = "sess-1"): ShareSession {
  const entries: ShareEntry[] = Array.from({ length: entryCount }, (_, index) => ({
    index,
    operationId: operationIdFor(sessionId, index),
    kind: "link", // placeholder; classifyEntries overrides it
    status: "pending" as const,
  }));
  return {
    version: 1,
    fingerprint: "fp",
    userId: "user-a",
    sessionId,
    phase: "active",
    entries,
  };
}

function makeDeps(overrides: Partial<ShareSaveDeps> = {}): ShareSaveDeps {
  return {
    saveLink: overrides.saveLink ?? (async ({ operationId }) => `items:link:${operationId}` as Id<"items">),
    saveNote: overrides.saveNote ?? (async ({ operationId }) => `items:note:${operationId}` as Id<"items">),
    saveImage:
      overrides.saveImage ??
      (async ({ operationId }) => ({
        status: "saved" as const,
        operationId,
        image: { uri: "stub" },
        itemId: `items:image:${operationId}` as Id<"items">,
      })),
  };
}

const urlPayload = (value: string): ResolvedPayload => ({
  contentType: "website",
  value,
  contentUri: null,
  contentMimeType: null,
});
const textPayload = (value: string): ResolvedPayload => ({
  contentType: "text",
  value,
  contentUri: null,
  contentMimeType: null,
});
const imagePayload = (uri: string | null): ResolvedPayload => ({
  contentType: "image",
  value: uri ?? "",
  contentUri: uri,
  contentMimeType: "image/jpeg",
});

// ---------------------------------------------------------------------------
// classifyPayload
// ---------------------------------------------------------------------------

describe("classifyPayload", () => {
  it("classifies a valid website as a link", () => {
    expect(classifyPayload(urlPayload("https://example.com"))).toEqual({ kind: "link" });
  });
  it("classifies text that looks like a URL as a link", () => {
    expect(classifyPayload(textPayload("example.com/path"))).toEqual({ kind: "link" });
  });
  it("classifies plain text as a note", () => {
    expect(classifyPayload(textPayload("a reminder"))).toEqual({ kind: "note" });
  });
  it("classifies an image with a contentUri as image", () => {
    expect(classifyPayload(imagePayload("file://img.jpg"))).toEqual({ kind: "image" });
  });
  it("fails an image with no contentUri", () => {
    expect(classifyPayload(imagePayload(null))).toEqual({
      kind: "image",
      reason: "Image could not be resolved",
    });
  });
  it("fails a website with a blank value", () => {
    expect(classifyPayload(urlPayload("   "))).toEqual({
      kind: "link",
      reason: "Shared link was not a valid URL",
    });
  });
  it("fails a website value that is not a URL", () => {
    expect(classifyPayload(urlPayload("not a url"))).toEqual({
      kind: "link",
      reason: "Shared link was not a valid URL",
    });
  });
  it("marks unsupported content types as unsupported, never a note", () => {
    expect(classifyPayload({ contentType: "audio", value: "x", contentUri: "file://a", contentMimeType: null })).toEqual({
      kind: "unsupported",
      reason: "Unsupported content type: audio",
    });
    expect(classifyPayload({ contentType: "video", value: "x", contentUri: "file://v", contentMimeType: null })).toMatchObject({
      kind: "unsupported",
    });
    expect(classifyPayload({ contentType: "file", value: "x", contentUri: "file://f", contentMimeType: null })).toMatchObject({
      kind: "unsupported",
    });
  });
  it("fails blank text rather than creating an empty note", () => {
    expect(classifyPayload(textPayload("   "))).toEqual({
      kind: "note",
      reason: "Shared text was empty",
    });
  });
});

// ---------------------------------------------------------------------------
// classifyEntries
// ---------------------------------------------------------------------------

describe("classifyEntries", () => {
  it("stamps kinds and terminal statuses without side effects", () => {
    const session = makeSession(3);
    const resolved = [
      urlPayload("https://a.example"), // link
      textPayload("note"), // note
      imagePayload(null), // failed image
    ];
    const entries = classifyEntries(session, resolved);
    expect(entries.map((e) => e.kind)).toEqual(["link", "note", "image"]);
    expect(entries.map((e) => e.status)).toEqual(["pending", "pending", "failed"]);
    expect(entries[2].message).toBe("Image could not be resolved");
  });
});

// ---------------------------------------------------------------------------
// processSession
// ---------------------------------------------------------------------------

describe("processSession", () => {
  it("saves all entries on full success and reports progress in order", () => {
    const session = makeSession(3);
    const resolved = [
      urlPayload("https://a.example"),
      textPayload("note body"),
      imagePayload("file://img.jpg"),
    ];
    const classified = classifyEntries(session, resolved);
    const settled: ShareEntry[] = [];
    const deps = makeDeps();

    return processSession({ ...session, entries: classified }, resolved, deps, (e) =>
      settled.push({ ...e }),
    ).then((result) => {
      expect(result.entries.map((e) => e.status)).toEqual(["saved", "saved", "saved"]);
      // Progress fired once per entry.
      expect(settled).toHaveLength(3);
      expect(settled.map((e) => e.index)).toEqual([0, 1, 2]);
    });
  });

  it("isolates a one-of-three failure: successes are retained", async () => {
    const session = makeSession(3);
    const resolved = [
      urlPayload("https://a.example"),
      urlPayload("https://b.example"),
      urlPayload("https://c.example"),
    ];
    const classified = classifyEntries(session, resolved);
    const deps = makeDeps({
      saveLink: async ({ url }) => {
        if (url.includes("b.example")) throw new Error("link b down");
        return `items:${url}` as Id<"items">;
      },
    });
    const result = await processSession({ ...session, entries: classified }, resolved, deps);

    expect(result.entries.map((e) => e.status)).toEqual(["saved", "failed", "saved"]);
    const failed = result.entries[1];
    expect(failed.kind).toBe("link");
    expect(failed.message).toBe("link b down");
    // The successful entries carry their item ids.
    expect(result.entries[0].itemId).toBeDefined();
    expect(result.entries[2].itemId).toBeDefined();
  });

  it("retries only failed entries on a second pass; saved entries are not re-saved", async () => {
    const saveLink = vi.fn(async ({ url, operationId }) => {
      if (url.includes("b.example")) throw new Error("still down");
      return `items:${operationId}` as Id<"items">;
    });
    const deps = makeDeps({ saveLink });

    const session = makeSession(3);
    const resolved = [
      urlPayload("https://a.example"),
      urlPayload("https://b.example"),
      urlPayload("https://c.example"),
    ];
    const classified = classifyEntries(session, resolved);
    const first = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(first.entries.map((e) => e.status)).toEqual(["saved", "failed", "saved"]);
    expect(saveLink).toHaveBeenCalledTimes(3);

    // Second pass reuses the SAME session (same operation ids). The caller
    // would persist first.entries before this; here we pass them straight back.
    saveLink.mockClear();
    const second = await processSession(first, resolved, deps);
    expect(second.entries.map((e) => e.status)).toEqual(["saved", "failed", "saved"]);
    // Only the still-failed entry (index 1) was re-invoked.
    expect(saveLink).toHaveBeenCalledTimes(1);
    expect(saveLink.mock.calls[0][0].operationId).toBe(operationIdFor("sess-1", 1));
  });

  it("does not invoke save for unsupported entries", async () => {
    const session = makeSession(2);
    const resolved = [
      { contentType: "audio", value: "song", contentUri: "file://song", contentMimeType: null },
      urlPayload("https://ok.example"),
    ] as ResolvedPayload[];
    const classified = classifyEntries(session, resolved);
    const saveLink = vi.fn(async ({ operationId }) => `items:${operationId}` as Id<"items">);
    const deps = makeDeps({ saveLink });

    const result = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(result.entries[0].status).toBe("unsupported");
    expect(result.entries[1].status).toBe("saved");
    expect(saveLink).toHaveBeenCalledTimes(1);
  });

  it("reports an image save failure from the injected save (a result, not a throw)", async () => {
    const session = makeSession(1);
    const resolved = [imagePayload("file://img.jpg")];
    const classified = classifyEntries(session, resolved);
    const deps = makeDeps({
      saveImage: async ({ operationId }) => ({
        status: "failed" as const,
        operationId,
        image: { uri: "file://img.jpg" },
        stage: "upload" as const,
        message: "Upload failed (502)",
      } satisfies ImageSaveResult),
    });
    const result = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(result.entries[0].status).toBe("failed");
    expect(result.entries[0].message).toBe("Upload failed (502)");
  });

  it("deduplicates an idempotent re-process: a saved entry's operation is not re-invoked", async () => {
    // The backend idempotency is the real guard, but the processor must ALSO not
    // re-invoke save for already-saved entries (avoids needless network).
    const session = makeSession(2);
    const resolved = [urlPayload("https://a.example"), urlPayload("https://b.example")];
    const classified = classifyEntries(session, resolved);
    const saveLink = vi.fn(async ({ operationId }) => `items:${operationId}` as Id<"items">);
    const deps = makeDeps({ saveLink });

    // Pre-mark entry 0 as saved (e.g. a prior session processed it).
    const pre = {
      ...session,
      entries: classified.map((e) =>
        e.index === 0 ? { ...e, status: "saved" as const, itemId: "items:prior" } : e,
      ),
    };
    const result = await processSession(pre, resolved, deps);
    expect(result.entries[0].status).toBe("saved");
    expect(result.entries[0].itemId).toBe("items:prior"); // unchanged
    expect(saveLink).toHaveBeenCalledTimes(1); // only entry 1
  });

  it("retries a failed entry and reports saved when the backend now returns the existing item", async () => {
    // Models the "ambiguous response then idempotent retry": the first attempt
    // failed at the network, the retry hits the completed operation and returns
    // the same item id the original would have.
    let attempts = 0;
    const saveLink = vi.fn(async ({ operationId }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("network blip");
      return "items:survived" as Id<"items">;
    });
    const deps = makeDeps({ saveLink });
    const session = makeSession(1);
    const resolved = [urlPayload("https://a.example")];
    const classified = classifyEntries(session, resolved);

    const first = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(first.entries[0].status).toBe("failed");

    const second = await processSession(first, resolved, deps);
    expect(second.entries[0].status).toBe("saved");
    expect(second.entries[0].itemId).toBe("items:survived");
    // Same operation id across both passes (stable retry key).
    expect(saveLink.mock.calls[0][0].operationId).toBe(saveLink.mock.calls[1][0].operationId);
  });

  it("does not re-attempt a malformed link/note and never calls the backend", async () => {
    // processOne must re-validate the payload and fail fast WITHOUT a save call,
    // rather than sending an empty url/text to the backend (pointless round-trip
    // that also overwrites the classifier's friendly message).
    const session = makeSession(2);
    const resolved = [
      urlPayload("   "), // blank website
      textPayload("   "), // blank text
    ];
    const classified = classifyEntries(session, resolved);
    expect(classified.map((e) => e.status)).toEqual(["failed", "failed"]);
    const saveLink = vi.fn(async () => "should-not-be-called" as Id<"items">);
    const saveNote = vi.fn(async () => "should-not-be-called" as Id<"items">);
    const deps = makeDeps({ saveLink, saveNote });

    const result = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(result.entries.map((e) => e.status)).toEqual(["failed", "failed"]);
    // No backend call was made for either malformed entry.
    expect(saveLink).not.toHaveBeenCalled();
    expect(saveNote).not.toHaveBeenCalled();
    // The classifier's friendly messages are preserved, not overwritten by a
    // backend "Invalid URL" / "Note text is empty" error.
    expect(result.entries[0].message).toBe("Shared link was not a valid URL");
    expect(result.entries[1].message).toBe("Shared text was empty");
  });

  it("saves an image correctly on resume even if its persisted kind placeholder is link", async () => {
    // Regression for the crash window: an entry classified image in-memory but
    // whose placeholder kind:'link' was persisted (the entry never settled
    // before the crash). On resume, processOne must re-derive 'image' from the
    // resolved payload and call saveImage — NOT saveLink.
    const session = makeSession(1);
    const resolved = [imagePayload("file://img.jpg")];
    // Simulate the persisted state: kind='link' placeholder, status='pending'.
    const persistedPending: ShareEntry[] = [
      { ...session.entries[0], kind: "link", status: "pending" },
    ];
    const saveImage = vi.fn(async ({ operationId }) => ({
      status: "saved" as const,
      operationId,
      image: { uri: "file://img.jpg" },
      itemId: "items:image-resume" as Id<"items">,
    }));
    const saveLink = vi.fn(async () => "should-not-be-called" as Id<"items">);
    const deps = makeDeps({ saveImage, saveLink });

    const result = await processSession(
      { ...session, entries: persistedPending },
      resolved,
      deps,
    );
    expect(result.entries[0].status).toBe("saved");
    expect(result.entries[0].itemId).toBe("items:image-resume");
    // Re-derived kind was image, so saveImage ran and saveLink did NOT.
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(saveLink).not.toHaveBeenCalled();
  });

  it("corrects a stale placeholder kind to the re-derived kind on resume", async () => {
    // Regression: on a resume where classifyEntries does not run (a sibling was
    // already settled so fresh=false), a pending entry may still carry its
    // placeholder kind:'link'. processOne re-derives the real kind; processSession
    // must merge that kind into the settled entry so the persisted record is
    // corrected — otherwise a crash here would leave a permanently wrong kind.
    const session = makeSession(1);
    const resolved = [imagePayload("file://img.jpg")];
    // Persisted state: placeholder kind:'link', still pending.
    const persistedPending: ShareEntry[] = [
      { ...session.entries[0], kind: "link", status: "pending" },
    ];
    const deps = makeDeps({
      saveImage: async ({ operationId }) => ({
        status: "saved" as const,
        operationId,
        image: { uri: "file://img.jpg" },
        itemId: "items:image-kind-fix" as Id<"items">,
      }),
    });

    const result = await processSession(
      { ...session, entries: persistedPending },
      resolved,
      deps,
    );
    // The settled kind is corrected to 'image', not left as the 'link' placeholder.
    expect(result.entries[0].kind).toBe("image");
    expect(result.entries[0].status).toBe("saved");
  });

  it("fails an image with no contentUri without a backend call", async () => {
    const session = makeSession(1);
    const resolved = [imagePayload(null)];
    const classified = classifyEntries(session, resolved);
    expect(classified[0].status).toBe("failed");
    const saveImage = vi.fn(async () => ({
      status: "saved" as const,
      operationId: "x",
      image: { uri: "x" },
      itemId: "should-not-be-called" as Id<"items">,
    }));
    const deps = makeDeps({ saveImage });
    const result = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(result.entries[0].status).toBe("failed");
    expect(result.entries[0].message).toBe("Image could not be resolved");
    expect(saveImage).not.toHaveBeenCalled();
  });

  it("sanitizes URLs and ids out of a thrown failure message", async () => {
    const session = makeSession(1);
    const resolved = [urlPayload("https://a.example")];
    const classified = classifyEntries(session, resolved);
    const deps = makeDeps({
      saveLink: async () => {
        throw new Error("POST https://upload.convex.cloud/abc failed kg2e5gqf40sy8kdqxcm3vp7hn96wtxyz");
      },
    });
    const result = await processSession({ ...session, entries: classified }, resolved, deps);
    expect(result.entries[0].status).toBe("failed");
    expect(result.entries[0].message).not.toContain("https://");
    expect(result.entries[0].message).not.toContain("kg2e5gqf40sy8kdqxcm3vp7hn96wtxyz");
  });
});
