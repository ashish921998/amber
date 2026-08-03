// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import { convexTest, type TestConvexForDataModel } from "convex-test";

import { api, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import { STALE_IMPORT_CUTOFF_MS } from "./items";
import schema from "./schema";

// The accessor returned by withIdentity (no further withIdentity/registerComponent).
// Used as the shared param type for helpers that drive either a base or
// identity-scoped test backend.
type TestCtx = TestConvexForDataModel<DataModel>;

// The module map lets convex-test discover and load function files.
const modules = import.meta.glob("./**/*.ts");

// A representative operation id (UUID-shaped, within the 8–200 char bound).
const OP_ID = "image:11111111-1111-4111-8111-111111111111";
const OP_ID_2 = "image:22222222-2222-4222-8222-222222222222";

// Each test gets its own authenticated user via withIdentity. subject is the
// value requireUserId returns, so different subjects model different users.
function as(userId: string): TestCtx {
  return convexTest(schema, modules).withIdentity({ subject: userId });
}

/** Uploads a blob to mock storage and returns its id, the way a real client
 * would after POSTing to the upload URL begin returns. */
async function storeBlob(t: TestCtx): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => {
    return await ctx.storage.store(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]));
  });
}

describe("image import lifecycle", () => {
  it("finalizes a pending operation into one item and schedules processing", async () => {
    const t = as("user-a");
    const begin = await t.mutation(api.items.beginImageImport, {
      operationId: OP_ID,
    });
    expect(begin.kind).toBe("upload");

    const storageId = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId,
    });
    const itemId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });
    expect(typeof itemId).toBe("string");

    // The scheduled AI job is queued; verify the item landed as processing.
    const op = await t.query(api.items.getImportOperation, { operationId: OP_ID });
    expect(op?.status).toBe("complete");
    expect(op?.itemId).toBe(itemId);
    expect(op?.storageId).toBe(storageId);

    const item = await t.run(async (ctx) => await ctx.db.get(itemId));
    expect(item?.type).toBe("image");
    expect(item?.status).toBe("processing");
    expect(item?.storageId).toBe(storageId);
  });

  it("returns the same item when begin/finalize repeat the same operation", async () => {
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const storageId = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId,
    });
    const firstId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });

    // A retry that begins the same completed operation should get the item back
    // without needing to re-upload.
    const began = await t.mutation(api.items.beginImageImport, {
      operationId: OP_ID,
    });
    expect(began).toEqual({ kind: "complete", itemId: firstId });

    // Finalizing again returns the same id, never a second item.
    const secondId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });
    expect(secondId).toBe(firstId);

    // Exactly one image item exists for this user.
    const items = await t.run(async (ctx) => {
      return await ctx.db
        .query("items")
        .withIndex("by_user", (q) => q.eq("userId", "user-a"))
        .collect();
    });
    expect(items.filter((i) => i.type === "image")).toHaveLength(1);
  });

  it("keeps the same operation id independent across users", async () => {
    // Both users must operate against ONE shared backend so the (userId,
    // operationId) pair — not database isolation — is what distinguishes them.
    const backend = convexTest(schema, modules);
    const ta = backend.withIdentity({ subject: "user-a" });
    const tb = backend.withIdentity({ subject: "user-b" });

    // user-a finalizes the operation.
    await ta.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const sa = await storeBlob(ta);
    await ta.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: sa,
    });
    const aId = await ta.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });

    // user-b using the same operation id is a separate operation and a separate
    // item — the (userId, operationId) pair is the unique key.
    await tb.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const sb = await storeBlob(tb);
    await tb.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: sb,
    });
    const bId = await tb.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });
    expect(bId).not.toBe(aId);

    const opA = await ta.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    const opB = await tb.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(opA?.itemId).toBe(aId);
    expect(opB?.itemId).toBe(bId);
  });

  it("rejects reusing an operation id with a different kind", async () => {
    // Seed a completed image operation directly.
    const t = as("user-a");
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID,
        kind: "image",
        status: "complete",
        updatedAt: Date.now(),
      });
    });

    // beginImageImport loads with kind "image" by default; a future link/note
    // flow (plan 004) would load with a different kind and must be rejected.
    // Simulate that by checking the helper's contract through the image path:
    // a second image operation with the same id is fine, but we assert a kind
    // mismatch throws when an op exists as a different kind.
    await t.run(async (ctx) => {
      const op = await ctx.db
        .query("itemOperations")
        .withIndex("by_user_operation", (q) =>
          q.eq("userId", "user-a").eq("operationId", OP_ID),
        )
        .unique();
      if (op === null) throw new Error("seed op missing");
      await ctx.db.patch(op._id, { kind: "link" });
    });
    await expect(
      t.mutation(api.items.beginImageImport, { operationId: OP_ID }),
    ).rejects.toThrow(/kind mismatch/i);
  });

  it("keeps one canonical storage id and discards a redundant attachment", async () => {
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const first = await storeBlob(t);
    const second = await storeBlob(t);

    const r1 = await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: first,
    });
    expect(r1.storageId).toBe(first);

    // A racing retry attaches a different storage id; first attachment wins and
    // the redundant blob is deleted.
    const r2 = await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: second,
    });
    expect(r2.storageId).toBe(first);

    // The redundant blob is gone; the canonical one survives.
    const secondGone = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", second),
    );
    expect(secondGone).toBeNull();
    const firstAlive = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", first),
    );
    expect(firstAlive).not.toBeNull();

    // Finalize uses the canonical storage id.
    const itemId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });
    const item = await t.run(async (ctx) => await ctx.db.get(itemId));
    expect(item?.storageId).toBe(first);
  });

  it("does not mark the operation complete on invalid metadata", async () => {
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const storageId = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId,
    });

    // An impossible aspect ratio must throw and must NOT complete the operation.
    await expect(
      t.mutation(api.items.finalizeImageImport, {
        operationId: OP_ID,
        aspectRatio: -1,
      }),
    ).rejects.toThrow(/aspectRatio/i);

    const op = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(op?.status).toBe("pending");

    // A corrected retry can still succeed.
    const itemId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
      aspectRatio: 1.5,
    });
    const opAfter = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(opAfter?.status).toBe("complete");
    expect(opAfter?.itemId).toBe(itemId);
  });

  it("releases the operation when its item is explicitly deleted", async () => {
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const storageId = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId,
    });
    const itemId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });

    await t.mutation(api.items.deleteItem, { id: itemId });

    // The operation row is gone, so the durable id can be re-performed.
    const op = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(op).toBeNull();

    // begin now treats it as a fresh operation (pending + new upload), not the
    // deleted item.
    const began = await t.mutation(api.items.beginImageImport, {
      operationId: OP_ID,
    });
    expect(began.kind).toBe("upload");
  });

  it("deletes only eligible unreferenced stale pending uploads", async () => {
    const t = as("user-a");

    // A stale pending operation with an attached upload (process died between
    // upload and finalize). Its storage should be swept.
    const staleStorageId = await storeBlob(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID,
        kind: "image",
        status: "pending",
        storageId: staleStorageId,
        // One hour past the staleness cutoff.
        updatedAt: Date.now() - STALE_IMPORT_CUTOFF_MS - 60 * 60 * 1000,
      });
    });

    // A fresh pending operation (well within the 24h window) — must survive.
    const freshStorageId = await storeBlob(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID_2,
        kind: "image",
        status: "pending",
        storageId: freshStorageId,
        updatedAt: Date.now(),
      });
    });

    await t.mutation(internal.items.cleanupStaleImageImports, {});

    // Stale op + its blob are gone.
    const staleOp = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(staleOp).toBeNull();
    const staleBlob = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", staleStorageId),
    );
    expect(staleBlob).toBeNull();

    // Fresh op + its blob survive.
    const freshOp = await t.query(api.items.getImportOperation, {
      operationId: OP_ID_2,
    });
    expect(freshOp?.status).toBe("pending");
    const freshBlob = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", freshStorageId),
    );
    expect(freshBlob).not.toBeNull();
  });

  it("refuses to adopt or delete a storage id referenced by a completed item", async () => {
    // A completed image for user-a with its own storage object.
    const ta = as("user-a");
    await ta.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const victimStorageId = await storeBlob(ta);
    await ta.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: victimStorageId,
    });
    await ta.mutation(api.items.finalizeImageImport, { operationId: OP_ID });

    // A malicious/buggy second operation tries to attach victimStorageId (which
    // is already referenced by user-a's completed item). attach must REJECT it
    // rather than adopt it — otherwise finalize/deleteItem could delete the
    // victim's storage. Defense: only unreferenced storage is adoptable.
    await ta.mutation(api.items.beginImageImport, { operationId: OP_ID_2 });
    await expect(
      ta.mutation(api.items.attachImageUpload, {
        operationId: OP_ID_2,
        storageId: victimStorageId,
      }),
    ).rejects.toThrow(/already in use/i);

    // The victim blob is intact (not deleted by the rejected attach).
    const victimAlive = await ta.run(async (ctx) =>
      ctx.db.system.get("_storage", victimStorageId),
    );
    expect(victimAlive).not.toBeNull();
  });

  it("returns the existing item when finalizing an already-complete op even with bad resubmitted metadata", async () => {
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const storageId = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId,
    });
    const firstId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
      aspectRatio: 1.5,
    });

    // A retry that resends an impossible aspectRatio must still return the
    // existing item — the idempotent read path is not gated on re-validation.
    const retriedId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
      aspectRatio: -1,
    });
    expect(retriedId).toBe(firstId);
  });

  it("deletes the redundant re-upload when attach lands on an already-complete op", async () => {
    // The headline retry race: the original attempt finalizes while a retry's
    // re-upload is in flight. The retry's attach must return the canonical id
    // AND delete its own redundant blob — nothing else references it, so the
    // pending-only cleanup cron would otherwise never reclaim it.
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const canonical = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: canonical,
    });
    await t.mutation(api.items.finalizeImageImport, { operationId: OP_ID });

    const redundant = await storeBlob(t);
    const result = await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: redundant,
    });
    expect(result.storageId).toBe(canonical);

    const redundantGone = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", redundant),
    );
    expect(redundantGone).toBeNull();
    const canonicalAlive = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", canonical),
    );
    expect(canonicalAlive).not.toBeNull();
  });

  it("refuses to adopt a storage id another pending operation holds", async () => {
    // Double-adopt defense: without the itemOperations check, one blob could
    // back two operations, finalize into two items sharing it, and be deleted
    // out from under the survivor when either item is deleted.
    const t = as("user-a");
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    const storageId = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId,
    });

    await t.mutation(api.items.beginImageImport, { operationId: OP_ID_2 });
    await expect(
      t.mutation(api.items.attachImageUpload, {
        operationId: OP_ID_2,
        storageId,
      }),
    ).rejects.toThrow(/already in use/i);

    // The first operation's pending upload is intact.
    const blobAlive = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", storageId),
    );
    expect(blobAlive).not.toBeNull();
  });

  it("rejects attaching a storage id that does not exist", async () => {
    // A swept blob's id must not become an item with a permanently dead image.
    const t = as("user-a");
    const storageId = await storeBlob(t);
    await t.run(async (ctx) => {
      await ctx.storage.delete(storageId);
    });
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID });
    await expect(
      t.mutation(api.items.attachImageUpload, {
        operationId: OP_ID,
        storageId,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("never deletes a blob a live item references, even from a stale pending row", async () => {
    // Inconsistent-but-possible state: a stale pending row holds a storageId
    // that a live item also references. The sweep must drop only the ledger
    // row and leave the blob alone.
    const t = as("user-a");
    const storageId = await storeBlob(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("items", {
        userId: "user-a",
        type: "image",
        status: "ready",
        storageId,
        tags: [],
        searchText: "",
      });
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID,
        kind: "image",
        status: "pending",
        storageId,
        updatedAt: Date.now() - STALE_IMPORT_CUTOFF_MS - 60 * 60 * 1000,
      });
    });

    await t.mutation(internal.items.cleanupStaleImageImports, {});

    const op = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(op).toBeNull();
    const blobAlive = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", storageId),
    );
    expect(blobAlive).not.toBeNull();
  });

  it("sweeps stale image rows even when stale non-image rows exist", async () => {
    // The kind-first index means link/note rows (plans 004/005) can never fill
    // the sweep page and starve image cleanup.
    const t = as("user-a");
    const staleAt = Date.now() - STALE_IMPORT_CUTOFF_MS - 60 * 60 * 1000;
    const imageBlob = await storeBlob(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: "link:stale-operation",
        kind: "link",
        status: "pending",
        updatedAt: staleAt,
      });
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID,
        kind: "image",
        status: "pending",
        storageId: imageBlob,
        updatedAt: staleAt,
      });
    });

    await t.mutation(internal.items.cleanupStaleImageImports, {});

    // The image row and its blob are swept; the link row is left to its owner.
    const imageOp = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(imageOp).toBeNull();
    const blobGone = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", imageBlob),
    );
    expect(blobGone).toBeNull();
    const linkOp = await t.query(api.items.getImportOperation, {
      operationId: "link:stale-operation",
    });
    expect(linkOp?.status).toBe("pending");
  });

  it("recycles a complete op whose item is gone and releases its orphaned blob", async () => {
    // Seed the inconsistent state directly (an item deleted NOT via deleteItem,
    // which would have released the row): begin must reset the row to pending,
    // delete the orphaned blob, and hand back a fresh upload URL.
    const t = as("user-a");
    const storageId = await storeBlob(t);
    const deadItemId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("items", {
        userId: "user-a",
        type: "image",
        status: "ready",
        storageId,
        tags: [],
        searchText: "",
      });
      await ctx.db.delete(id);
      return id;
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID,
        kind: "image",
        status: "complete",
        storageId,
        itemId: deadItemId,
        updatedAt: Date.now(),
      });
    });

    const began = await t.mutation(api.items.beginImageImport, {
      operationId: OP_ID,
    });
    expect(began.kind).toBe("upload");

    const op = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(op?.status).toBe("pending");
    expect(op?.storageId).toBeUndefined();
    const blobGone = await t.run(async (ctx) =>
      ctx.db.system.get("_storage", storageId),
    );
    expect(blobGone).toBeNull();
  });

  it("recycles an inconsistent complete op (no itemId) and clears its stale storageId", async () => {
    // Defensive branch: a complete row with no itemId. Recycling must clear
    // the stale storageId — left in place, attach would treat it as canonical
    // and delete the fresh re-upload as "redundant".
    const t = as("user-a");
    const staleBlob = await storeBlob(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: OP_ID,
        kind: "image",
        status: "complete",
        storageId: staleBlob,
        updatedAt: Date.now(),
      });
    });

    const began = await t.mutation(api.items.beginImageImport, {
      operationId: OP_ID,
    });
    expect(began.kind).toBe("upload");
    const op = await t.query(api.items.getImportOperation, {
      operationId: OP_ID,
    });
    expect(op?.status).toBe("pending");
    expect(op?.storageId).toBeUndefined();

    // A fresh upload then attaches and finalizes normally.
    const freshBlob = await storeBlob(t);
    await t.mutation(api.items.attachImageUpload, {
      operationId: OP_ID,
      storageId: freshBlob,
    });
    const itemId = await t.mutation(api.items.finalizeImageImport, {
      operationId: OP_ID,
    });
    const item = await t.run(async (ctx) => await ctx.db.get(itemId));
    expect(item?.storageId).toBe(freshBlob);
  });

  it("rejects operation ids outside the allowed length bounds", async () => {
    const t = as("user-a");
    await expect(
      t.mutation(api.items.beginImageImport, { operationId: "short" }),
    ).rejects.toThrow(/Invalid operationId/i);
    await expect(
      t.mutation(api.items.beginImageImport, {
        operationId: "x".repeat(201),
      }),
    ).rejects.toThrow(/Invalid operationId/i);
  });

  it("rejects finalize when the operation was never begun or never attached", async () => {
    const t = as("user-a");
    // Never begun.
    await expect(
      t.mutation(api.items.finalizeImageImport, { operationId: OP_ID }),
    ).rejects.toThrow(/no attached upload/i);

    // Begun but never attached (process died between upload and attach). The
    // op must stay pending so a later attach + finalize can still succeed.
    await t.mutation(api.items.beginImageImport, { operationId: OP_ID_2 });
    await expect(
      t.mutation(api.items.finalizeImageImport, { operationId: OP_ID_2 }),
    ).rejects.toThrow(/no attached upload/i);
    const op = await t.query(api.items.getImportOperation, {
      operationId: OP_ID_2,
    });
    expect(op?.status).toBe("pending");
  });

  it("rejects unauthenticated callers on every import entry point", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.items.beginImageImport, { operationId: OP_ID }),
    ).rejects.toThrow();
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1])])),
    );
    await expect(
      t.mutation(api.items.attachImageUpload, { operationId: OP_ID, storageId }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.items.finalizeImageImport, { operationId: OP_ID }),
    ).rejects.toThrow();
    await expect(
      t.query(api.items.getImportOperation, { operationId: OP_ID }),
    ).rejects.toThrow();
  });
});

// Plan 004: shared links and notes use the same operation ledger as images so
// a share retry never duplicates a saved link/note and never resubmits one.
// These IDs are deliberately distinct from the image OP_* ids above so a cross-
// kind mismatch test can reuse the (userId, operationId) namespace cleanly.
const LINK_OP = "link:33333333-3333-4333-8333-333333333333";
const NOTE_OP = "note:44444444-4444-4444-8444-444444444444";

describe("shared link/note operation idempotency", () => {
  it("creates one link for a repeated shared operation and returns the same id", async () => {
    const t = as("user-a");
    const firstId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/share",
      operationId: LINK_OP,
    });
    const secondId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/share",
      operationId: LINK_OP,
    });
    expect(secondId).toBe(firstId);

    // Exactly one link item exists for this user.
    const items = await t.run(async (ctx) => {
      return await ctx.db
        .query("items")
        .withIndex("by_user", (q) => q.eq("userId", "user-a"))
        .collect();
    });
    expect(items.filter((i) => i.type === "link")).toHaveLength(1);
  });

  it("creates one note for a repeated shared operation and returns the same id", async () => {
    const t = as("user-a");
    const firstId = await t.mutation(api.items.createNoteItem, {
      text: "shared note",
      operationId: NOTE_OP,
    });
    const secondId = await t.mutation(api.items.createNoteItem, {
      text: "shared note",
      operationId: NOTE_OP,
    });
    expect(secondId).toBe(firstId);

    const items = await t.run(async (ctx) => {
      return await ctx.db
        .query("items")
        .withIndex("by_user", (q) => q.eq("userId", "user-a"))
        .collect();
    });
    expect(items.filter((i) => i.type === "note")).toHaveLength(1);
  });

  it("rejects reusing a link operation id for a note (kind mismatch)", async () => {
    const t = as("user-a");
    await t.mutation(api.items.createLinkItem, {
      url: "example.com/kind",
      operationId: LINK_OP,
    });
    await expect(
      t.mutation(api.items.createNoteItem, {
        text: "wrong kind",
        operationId: LINK_OP,
      }),
    ).rejects.toThrow(/kind mismatch/i);
  });

  it("rejects reusing an image operation id for a link", async () => {
    // Seed a completed image operation directly, then attempt a link create with
    // the same operation id — the kind guard must reject it.
    const t = as("user-a");
    await t.run(async (ctx) => {
      await ctx.db.insert("itemOperations", {
        userId: "user-a",
        operationId: LINK_OP,
        kind: "image",
        status: "complete",
        updatedAt: Date.now(),
      });
    });
    await expect(
      t.mutation(api.items.createLinkItem, {
        url: "example.com/clash",
        operationId: LINK_OP,
      }),
    ).rejects.toThrow(/kind mismatch/i);
  });

  it("isolates the same operation id across users", async () => {
    const backend = convexTest(schema, modules);
    const ta = backend.withIdentity({ subject: "user-a" });
    const tb = backend.withIdentity({ subject: "user-b" });

    const aId = await ta.mutation(api.items.createLinkItem, {
      url: "example.com/shared",
      operationId: LINK_OP,
    });
    const bId = await tb.mutation(api.items.createLinkItem, {
      url: "example.com/shared",
      operationId: LINK_OP,
    });
    expect(bId).not.toBe(aId);

    // Each user has their own link item.
    const aItems = await ta.run(async (ctx) =>
      ctx.db
        .query("items")
        .withIndex("by_user", (q) => q.eq("userId", "user-a"))
        .collect(),
    );
    const bItems = await tb.run(async (ctx) =>
      ctx.db
        .query("items")
        .withIndex("by_user", (q) => q.eq("userId", "user-b"))
        .collect(),
    );
    expect(aItems.filter((i) => i.type === "link")).toHaveLength(1);
    expect(bItems.filter((i) => i.type === "link")).toHaveLength(1);
  });

  it("creates two intentional items for identical content under distinct operations", async () => {
    // Idempotency is per-operation, never per-content: the same URL shared twice
    // (different share sessions) is two deliberate saves, not a deduplicated one.
    const t = as("user-a");
    const firstId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/dup",
      operationId: "link:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const secondId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/dup",
      operationId: "link:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(secondId).not.toBe(firstId);

    const items = await t.run(async (ctx) => {
      return await ctx.db
        .query("items")
        .withIndex("by_user", (q) => q.eq("userId", "user-a"))
        .collect();
    });
    expect(items.filter((i) => i.type === "link")).toHaveLength(2);
  });

  it("still creates a fresh item when no operation id is given (Add UI path)", async () => {
    const t = as("user-a");
    const firstId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/add",
    });
    const secondId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/add",
    });
    expect(secondId).not.toBe(firstId);

    // No ledger rows are written on the non-idempotent path.
    const ops = await t.run(async (ctx) =>
      ctx.db.query("itemOperations").collect(),
    );
    expect(ops).toHaveLength(0);
  });

  it("schedules processItem exactly once per link/note create, on both paths", async () => {
    // Regression: the operation-guarded path used to call insertLinkOrNote
    // (which schedules processItem) AND then schedule processItem again itself,
    // running the AI pipeline twice and racing two concurrent classifications.
    // Both the guarded (operationId) and ordinary paths must schedule exactly
    // one processItem job for the created item — no more.
    const t = as("user-a");

    // Guarded path (share flow).
    const guardedId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/guarded",
      operationId: LINK_OP,
    });
    // Ordinary path (Add UI).
    const plainId = await t.mutation(api.items.createNoteItem, {
      text: "plain note",
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const processJobs = scheduled.filter((j) => j.name === "ai:processItem");
    // Exactly two jobs total — one per create — and each targets its own item.
    expect(processJobs).toHaveLength(2);
    const targeted = processJobs.flatMap((j) =>
      // args is stored as a single-element array wrapping the mutation args.
      (j.args as unknown as { itemId: Id<"items"> }[]).map((a) => a.itemId),
    );
    expect(targeted).toContain(guardedId);
    expect(targeted).toContain(plainId);

    // A repeat create on the completed guarded operation (idempotent hit) must
    // NOT schedule processItem again — the item already exists and was processed.
    await t.mutation(api.items.createLinkItem, {
      url: "example.com/guarded",
      operationId: LINK_OP,
    });
    const scheduledAfter = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduledAfter.filter((j) => j.name === "ai:processItem"),
    ).toHaveLength(2);
  });

  it("releases the link operation when its item is deleted, allowing re-perform", async () => {
    const t = as("user-a");
    const itemId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/delete-me",
      operationId: LINK_OP,
    });
    await t.mutation(api.items.deleteItem, { id: itemId });

    // The operation row is gone, so a new share with the same id performs fresh.
    const op = await t.query(api.items.getImportOperation, {
      operationId: LINK_OP,
    });
    expect(op).toBeNull();

    const redoId = await t.mutation(api.items.createLinkItem, {
      url: "example.com/delete-me",
      operationId: LINK_OP,
    });
    expect(redoId).not.toBe(itemId);
  });

  it("rejects invalid operation ids on the link/note paths", async () => {
    const t = as("user-a");
    await expect(
      t.mutation(api.items.createLinkItem, {
        url: "example.com",
        operationId: "short",
      }),
    ).rejects.toThrow(/Invalid operationId/i);
    await expect(
      t.mutation(api.items.createNoteItem, {
        text: "x",
        operationId: "x".repeat(201),
      }),
    ).rejects.toThrow(/Invalid operationId/i);
  });

  it("rejects empty note text on the idempotent path without completing the op", async () => {
    const t = as("user-a");
    await expect(
      t.mutation(api.items.createNoteItem, {
        text: "   ",
        operationId: NOTE_OP,
      }),
    ).rejects.toThrow(/empty/i);
    // No item, no operation row was created.
    const op = await t.query(api.items.getImportOperation, {
      operationId: NOTE_OP,
    });
    expect(op).toBeNull();
  });

  it("rejects an invalid url on the idempotent path without completing the op", async () => {
    const t = as("user-a");
    // The centralized URL policy rejects empty/whitespace URLs before any
    // operation row is created. The error category is "empty"; the important
    // contract is that the op is not recorded, so a corrected retry is clean.
    await expect(
      t.mutation(api.items.createLinkItem, {
        url: "  ",
        operationId: LINK_OP,
      }),
    ).rejects.toThrow(/empty/i);
    const op = await t.query(api.items.getImportOperation, {
      operationId: LINK_OP,
    });
    expect(op).toBeNull();
  });
});
