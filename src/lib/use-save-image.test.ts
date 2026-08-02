// Tests for the pure saveImageOperations orchestration. The React/Convex
// adapter (useSaveImages) and the expo modules it imports are not exercised
// here — only the dependency-injected orchestration, which is where the
// per-image settled-result contract lives. Runs in the Node default env.
import {
  saveImageOperations,
  type ImageSaveResult,
  type SaveImageDeps,
} from "./use-save-image";
import { describe, expect, it, vi } from "vitest";

// Stub the expo modules the module under test imports at the top level, so it
// loads under Node without a React Native runtime. Vitest hoists these mocks
// above the imports above, so the module under test sees the stubs at load
// time. Only the orchestration (which receives its deps as arguments) is
// exercised.
vi.mock("expo-file-system", () => ({ File: class {} }));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "stub-uuid" }));
vi.mock("@convex/_generated/api", () => ({ api: {} }));
vi.mock("@convex/_generated/dataModel", () => ({}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));

// Build a deps object from per-stage behaviors. Each stage is an async fn so a
// test can make a specific stage throw to assert the reported failure stage.
function makeDeps(overrides: Partial<SaveImageDeps> = {}): SaveImageDeps {
  return {
    begin: overrides.begin ?? (async () => ({ kind: "upload", uploadUrl: "https://upload.test" })),
    upload: overrides.upload ?? (async () => "ks_storage_uploaded" as never),
    attach: overrides.attach ?? (async (_op, storageId) => ({ storageId })),
    finalize: overrides.finalize ?? (async () => "ks_items_final" as never),
  };
}

const img = (uri: string) => ({ uri });

describe("saveImageOperations", () => {
  it("returns one settled result per input in input order on full success", async () => {
    const deps = makeDeps();
    const requests = [
      { image: img("a") },
      { image: img("b") },
      { image: img("c") },
    ];
    const results = await saveImageOperations(requests, deps);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.status)).toEqual(["saved", "saved", "saved"]);
    // Results follow input order even though tasks run concurrently.
    expect((results[0] as Extract<ImageSaveResult, { status: "saved" }>).image.uri).toBe("a");
    expect((results[2] as Extract<ImageSaveResult, { status: "saved" }>).image.uri).toBe("c");
    // Each result carries the operation id it minted.
    for (const r of results) {
      expect(r.operationId).toMatch(/^image:stub-uuid$/);
    }
  });

  it("reports a failed image without hiding its siblings' successes", async () => {
    const deps = makeDeps({
      upload: async (image) => {
        if (image.uri === "b") throw new Error("boom");
        return "ks_storage_ok" as never;
      },
    });
    const results = await saveImageOperations(
      [{ image: img("a") }, { image: img("b") }, { image: img("c") }],
      deps,
    );

    expect(results.map((r) => r.status)).toEqual(["saved", "failed", "saved"]);
    const failed = results[1] as Extract<ImageSaveResult, { status: "failed" }>;
    expect(failed.stage).toBe("upload");
    // A sanitized message, not a stack trace.
    expect(failed.message).toBe("boom");
  });

  it("lets a retry submit only the failed operation id, reusing it verbatim", async () => {
    // First pass: finalize fails for "b".
    let finalized = new Set<string>();
    const deps = makeDeps({
      finalize: async (input) => {
        // Use the operationId embedded by the request to differentiate.
        throw new Error("finalize down");
      },
    });
    const firstResults = await saveImageOperations(
      [
        { image: img("a"), operationId: "image:op-a" },
        { image: img("b"), operationId: "image:op-b" },
      ],
      deps,
    );
    const failed = firstResults.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(2);

    // The caller retries ONLY the failed results, passing their existing op ids.
    // No new id is minted for a retry.
    const retryRequests = failed.map((r) => ({
      image: r.image,
      operationId: r.operationId,
    }));
    expect(retryRequests.map((r) => r.operationId).sort()).toEqual([
      "image:op-a",
      "image:op-b",
    ]);

    // Second pass with a working finalize: the same op ids come back saved.
    const retryDeps = makeDeps({
      finalize: async (input) => {
        finalized.add(input.operationId);
        return `ks_items_${input.operationId}` as never;
      },
    });
    const retryResults = await saveImageOperations(retryRequests, retryDeps);
    expect(retryResults.map((r) => r.status)).toEqual(["saved", "saved"]);
    expect(
      (retryResults.map((r) => r.operationId).sort() as string[]),
    ).toEqual(["image:op-a", "image:op-b"]);
    expect(finalized.has("image:op-a")).toBe(true);
    expect(finalized.has("image:op-b")).toBe(true);
  });

  it("skips the upload when begin reports the operation already complete", async () => {
    const upload = vi.fn(async () => "ks_storage_should_not_run" as never);
    const deps = makeDeps({
      begin: async () => ({ kind: "complete", itemId: "ks_items_existing" as never }),
      upload,
    });
    const results = await saveImageOperations(
      [{ image: img("a"), operationId: "image:op-a" }],
      deps,
    );
    expect(upload).not.toHaveBeenCalled();
    const saved = results[0] as Extract<ImageSaveResult, { status: "saved" }>;
    expect(saved.itemId).toBe("ks_items_existing");
    expect(saved.operationId).toBe("image:op-a");
  });

  it("reports the correct stage when begin fails", async () => {
    const deps = makeDeps({ begin: async () => {
      throw new Error("begin down");
    } });
    const results = await saveImageOperations(
      [{ image: img("a"), operationId: "image:op-a" }],
      deps,
    );
    expect(results[0].status).toBe("failed");
    expect((results[0] as Extract<ImageSaveResult, { status: "failed" }>).stage).toBe("begin");
  });

  it("reports the correct stage when attach fails", async () => {
    const deps = makeDeps({
      attach: async () => {
        throw new Error("attach down");
      },
    });
    const results = await saveImageOperations(
      [{ image: img("a"), operationId: "image:op-a" }],
      deps,
    );
    expect((results[0] as Extract<ImageSaveResult, { status: "failed" }>).stage).toBe("attach");
  });

  it("reports the correct stage when finalize fails", async () => {
    const deps = makeDeps({
      finalize: async () => {
        throw new Error("finalize down");
      },
    });
    const results = await saveImageOperations(
      [{ image: img("a"), operationId: "image:op-a" }],
      deps,
    );
    expect((results[0] as Extract<ImageSaveResult, { status: "failed" }>).stage).toBe("finalize");
  });

  it("sanitizes URLs and ids out of the failure message", async () => {
    const deps = makeDeps({
      upload: async () => {
        throw new Error(
          "POST https://upload.convex.cloud/abc failed for ks_storage_xyz and ks_items_123",
        );
      },
    });
    const results = await saveImageOperations(
      [{ image: img("a"), operationId: "image:op-a" }],
      deps,
    );
    const failed = results[0] as Extract<ImageSaveResult, { status: "failed" }>;
    expect(failed.message).not.toContain("https://");
    expect(failed.message).not.toContain("ks_storage_xyz");
    expect(failed.message).not.toContain("ks_items_123");
  });
});
