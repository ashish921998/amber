import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId } from "./model/auth";
import { effectiveStatus } from "./model/memberships";

/** Practical per-query cap so a very large library can't blow the read limit. */
const LIST_CAP = 1000;

const itemTypeValidator = v.union(
  v.literal("image"),
  v.literal("link"),
  v.literal("note"),
);

const itemStatusValidator = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed"),
);

// A pressable action the AI attaches to an item. `kind` is a closed set so the
// client can map each one to a guaranteed-executable handler and a valid icon;
// `label` is the button text and `value` is the payload (URL, text, number…).
export const intentKindValidator = v.union(
  v.literal("open_url"),
  v.literal("copy"),
  v.literal("web_search"),
  v.literal("open_maps"),
  v.literal("call"),
  v.literal("email"),
  v.literal("message"),
  v.literal("add_event"),
);

export const intentValidator = v.object({
  kind: intentKindValidator,
  label: v.string(),
  value: v.string(),
});

// A real product result from the user-triggered "Find links" pass. Mirrors
// the schema; price stays a display string ("$1,299.00") — no math happens.
export const productValidator = v.object({
  title: v.string(),
  url: v.string(),
  price: v.optional(v.string()),
  merchant: v.optional(v.string()),
  thumbnailUrl: v.optional(v.string()),
});

export const productsStatusValidator = v.union(
  v.literal("searching"),
  v.literal("ready"),
  v.literal("failed"),
);

const itemFields = {
  _id: v.id("items"),
  _creationTime: v.number(),
  userId: v.string(),
  type: itemTypeValidator,
  status: itemStatusValidator,
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  url: v.optional(v.string()),
  storageId: v.optional(v.id("_storage")),
  aspectRatio: v.optional(v.number()),
  capturedAt: v.optional(v.number()),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
  isSticker: v.optional(v.boolean()),
  tags: v.array(v.string()),
  content: v.optional(v.string()),
  siteName: v.optional(v.string()),
  heroImageUrl: v.optional(v.string()),
  note: v.optional(v.string()),
  intents: v.optional(v.array(intentValidator)),
  products: v.optional(v.array(productValidator)),
  productsStatus: v.optional(productsStatusValidator),
  searchText: v.string(),
};

// Exported so spaces.ts reuses the exact same shape — a second hand-written
// copy is how `capturedAt`/`intents` drifted out of getSpace's validator.
export const enrichedItemValidator = v.object({
  ...itemFields,
  imageUrl: v.union(v.string(), v.null()),
});

const enrichedItemWithSpacesValidator = v.object({
  ...itemFields,
  imageUrl: v.union(v.string(), v.null()),
  spaces: v.array(
    v.object({
      _id: v.id("spaces"),
      name: v.string(),
    }),
  ),
});

export async function enrichItem(ctx: QueryCtx, item: Doc<"items">) {
  const imageUrl = item.storageId
    ? await ctx.storage.getUrl(item.storageId)
    : null;
  return { ...item, imageUrl };
}

function buildSearchText(parts: {
  title?: string;
  description?: string;
  tags: string[];
  siteName?: string;
}): string {
  return [parts.title, parts.description, ...parts.tags, parts.siteName]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ")
    .toLowerCase();
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

export const listItems = query({
  args: {},
  returns: v.array(enrichedItemValidator),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const items = await ctx.db
      .query("items")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(LIST_CAP);
    return await Promise.all(items.map((item) => enrichItem(ctx, item)));
  },
});

export const getItem = query({
  args: { id: v.id("items") },
  returns: v.union(enrichedItemWithSpacesValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const item = await ctx.db.get(args.id);
    if (item === null || item.userId !== userId) {
      return null;
    }
    const joins = await ctx.db
      .query("spaceItems")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .collect();
    const spaces: { _id: Id<"spaces">; name: string }[] = [];
    for (const join of joins) {
      // Only real memberships appear as chips — suggestions and dismissals
      // are space-screen concerns, not part of the item's identity.
      if (effectiveStatus(join) !== "saved") {
        continue;
      }
      const space = await ctx.db.get(join.spaceId);
      if (space !== null) {
        spaces.push({ _id: space._id, name: space.name });
      }
    }
    const enriched = await enrichItem(ctx, item);
    return { ...enriched, spaces };
  },
});

export const searchItems = query({
  args: { query: v.string() },
  returns: v.array(enrichedItemValidator),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const trimmed = args.query.trim();
    if (trimmed === "") {
      return [];
    }
    const items = await ctx.db
      .query("items")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", trimmed.toLowerCase()).eq("userId", userId),
      )
      .take(50);
    return await Promise.all(items.map((item) => enrichItem(ctx, item)));
  },
});

// Similar-items v0: lexical overlap, no new infra. Tags carry most of the
// signal (they're the classifier's own summary), searchText tokens catch the
// rest. A vector index over real embeddings replaces this in v1.
const SIMILAR_CANDIDATES = 300;
const SIMILAR_LIMIT = 10;
const SIMILAR_MIN_SCORE = 3;

function searchTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3),
  );
}

export const similarItems = query({
  args: { id: v.id("items") },
  returns: v.array(enrichedItemValidator),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const item = await ctx.db.get(args.id);
    if (item === null || item.userId !== userId || item.status !== "ready") {
      return [];
    }
    const tags = new Set(item.tags);
    const tokens = searchTokens(item.searchText);
    if (tags.size === 0 && tokens.size === 0) {
      return [];
    }

    const candidates = await ctx.db
      .query("items")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(SIMILAR_CANDIDATES);

    const scored: { item: Doc<"items">; score: number }[] = [];
    for (const candidate of candidates) {
      if (candidate._id === item._id || candidate.status !== "ready") {
        continue;
      }
      let score = 0;
      for (const tag of candidate.tags) {
        if (tags.has(tag)) {
          score += 3;
        }
      }
      for (const token of searchTokens(candidate.searchText)) {
        if (tokens.has(token)) {
          score += 1;
        }
      }
      if (score >= SIMILAR_MIN_SCORE) {
        scored.push({ item: candidate, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return await Promise.all(
      scored
        .slice(0, SIMILAR_LIMIT)
        .map(({ item: match }) => enrichItem(ctx, match)),
    );
  },
});

// ---------------------------------------------------------------------------
// Public mutations
// ---------------------------------------------------------------------------

/**
 * Adding from inside a space files the new item there immediately — a real
 * `saved` membership, the user's own act, never subject to AI review.
 */
async function saveIntoSpace(
  ctx: MutationCtx,
  userId: string,
  itemId: Id<"items">,
  spaceId: Id<"spaces">,
): Promise<void> {
  const space = await ctx.db.get(spaceId);
  if (space === null || space.userId !== userId) {
    throw new Error("Space not found");
  }
  await ctx.db.insert("spaceItems", {
    userId,
    spaceId,
    itemId,
    status: "saved",
  });
}

// ---------------------------------------------------------------------------
// Image import operation ledger
// ---------------------------------------------------------------------------
//
// Idempotent image save with a stable per-image operation ID so a retry never
// duplicates a success and never resubmits one. The client flow is:
//
//   begin  -> { uploadUrl } (or { itemId } if already finalized)
//   upload bytes to the upload URL out-of-band (outside the Convex txn)
//   attach -> records the storageId on the pending operation
//   finalize -> validates metadata and atomically inserts the item + completes
//
// Correctness goal is idempotency + compensation, NOT upload+DB atomicity: a
// process can crash after the upload succeeds but before `attach` records the
// storageId, leaving an unreferenced blob. That narrow gap is swept by the
// stale-pending cleanup cron; it is documented, not eliminated.

/** Operation IDs are opaque client UUIDs (optionally prefixed for logs). This
 * bounds length so a stray empty/huge string can't pollute the index. */
const OPERATION_ID_MIN = 8;
const OPERATION_ID_MAX = 200;

function requireOperationId(operationId: string): void {
  if (
    typeof operationId !== "string" ||
    operationId.length < OPERATION_ID_MIN ||
    operationId.length > OPERATION_ID_MAX
  ) {
    throw new Error("Invalid operationId");
  }
}

/** Loads the caller's image operation for `operationId`, or null. The (userId,
 * operationId) pair is the logical unique key — never look one up without both.
 * Callers that expect a specific `kind` must pass it so a reused operation ID
 * can't silently switch from image to link/note. */
async function loadImageOperation(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  operationId: string,
  kind: "image" | "link" | "note" = "image",
): Promise<Doc<"itemOperations"> | null> {
  const op = await ctx.db
    .query("itemOperations")
    .withIndex("by_user_operation", (q) =>
      q.eq("userId", userId).eq("operationId", operationId),
    )
    .unique();
  if (op === null) {
    return null;
  }
  if (op.kind !== kind) {
    throw new Error("Operation kind mismatch");
  }
  return op;
}

/** True iff no items document references `storageId`. attachImageUpload uses
 * this to make a client-supplied storage id deletable ONLY when it is a fresh,
 * unreferenced upload (a redundant retry re-upload) — never another user's
 * completed-image storage object. A malicious caller cannot weaponize attach to
 * delete storage they don't own, because a referenced blob is never deleted. */
async function isStorageUnreferenced(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<boolean> {
  const ref = await ctx.db
    .query("items")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  return ref === null;
}

/** Discriminated return for beginImageImport. A named type (rather than inline
 * object literals) keeps `kind` a literal so the `returns` validator matches. */
type BeginImageImportResult =
  | { kind: "upload"; uploadUrl: string }
  | { kind: "complete"; itemId: Id<"items"> };

/** Validates image metadata exactly as the legacy createImageItem did, so
 * finalize rejects bad input without marking the operation complete. */
function validateImageMetadata(args: {
  aspectRatio?: number;
  latitude?: number;
  longitude?: number;
}): void {
  if (
    args.aspectRatio !== undefined &&
    (!Number.isFinite(args.aspectRatio) || args.aspectRatio <= 0)
  ) {
    throw new Error("Invalid aspectRatio");
  }
  // Location is all-or-nothing: a lone latitude can't be plotted.
  const hasLocation =
    args.latitude !== undefined && args.longitude !== undefined;
  if (
    (args.latitude !== undefined || args.longitude !== undefined) &&
    (!hasLocation ||
      !Number.isFinite(args.latitude) ||
      Math.abs(args.latitude!) > 90 ||
      !Number.isFinite(args.longitude) ||
      Math.abs(args.longitude!) > 180)
  ) {
    throw new Error("Invalid location");
  }
}

export const beginImageImport = mutation({
  args: { operationId: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("upload"), uploadUrl: v.string() }),
    v.object({ kind: v.literal("complete"), itemId: v.id("items") }),
  ),
  handler: async (ctx, args): Promise<BeginImageImportResult> => {
    const userId = await requireUserId(ctx);
    requireOperationId(args.operationId);
    const op = await loadImageOperation(ctx, userId, args.operationId);
    const now = Date.now();

    if (op === null) {
      // (userId, operationId) uniqueness is enforced by Convex's serializable
      // transactions: if two begins race on an empty index range, only one
      // insert commits; the other's transaction is retried and will observe
      // the row above as a pending op. No application-level unique index exists
      // because Convex has no unique secondary indexes — this OCC + retry is
      // the supported idiom.
      await ctx.db.insert("itemOperations", {
        userId,
        operationId: args.operationId,
        kind: "image",
        status: "pending",
        updatedAt: now,
      });
      return {
        kind: "upload",
        uploadUrl: await ctx.storage.generateUploadUrl(),
      };
    }

    if (op.status === "complete") {
      // A complete operation whose item was explicitly deleted is recyclable:
      // reset to pending so the durable operationId performs a fresh save.
      if (op.itemId !== undefined) {
        const item = await ctx.db.get(op.itemId);
        if (item === null) {
          // Release the now-orphaned storage object before resetting the row,
          // otherwise the blob leaks (the cleanup cron only sweeps pending
          // rows, and this row is currently complete).
          if (op.storageId !== undefined) {
            await ctx.storage.delete(op.storageId);
          }
          await ctx.db.patch(op._id, {
            status: "pending",
            itemId: undefined,
            storageId: undefined,
            updatedAt: now,
          });
          return {
            kind: "upload",
            uploadUrl: await ctx.storage.generateUploadUrl(),
          };
        }
        return { kind: "complete", itemId: op.itemId };
      }
      // Defensive: a complete row with no itemId is inconsistent; recycle it.
      await ctx.db.patch(op._id, { status: "pending", updatedAt: now });
      return {
        kind: "upload",
        uploadUrl: await ctx.storage.generateUploadUrl(),
      };
    }

    // Pending: refresh updatedAt (a begin is active interest) and hand back a
    // fresh URL. A retry that re-uploads is correct-by-design — attach keeps
    // the first storageId and discards the redundant blob.
    await ctx.db.patch(op._id, { updatedAt: now });
    return {
      kind: "upload",
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  },
});

export const attachImageUpload = mutation({
  args: {
    operationId: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.object({ storageId: v.id("_storage") }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    requireOperationId(args.operationId);
    const op = await loadImageOperation(ctx, userId, args.operationId);
    const now = Date.now();

    if (op === null) {
      // No begin happened (or the row was swept). Adopt the caller's storage id
      // only if it isn't already referenced by a completed item (defense: a
      // malicious caller could pass another user's storage id here).
      if (!(await isStorageUnreferenced(ctx, args.storageId))) {
        throw new Error("Storage object is already in use");
      }
      await ctx.db.insert("itemOperations", {
        userId,
        operationId: args.operationId,
        kind: "image",
        status: "pending",
        storageId: args.storageId,
        updatedAt: now,
      });
      return { storageId: args.storageId };
    }

    if (op.status === "complete") {
      // Already finalized: return the canonical id. We never delete on this
      // path — the incoming id may belong to a different completed item.
      return { storageId: (op.storageId ?? args.storageId) };
    }

    // First attachment wins. A racing retry that supplies a different storageId
    // has re-uploaded redundantly; delete the REDUNDANT (incoming) blob — but
    // only if it is unreferenced, so a client can never delete storage it
    // doesn't own (e.g. another user's completed-image blob).
    if (op.storageId !== undefined && op.storageId !== args.storageId) {
      if (await isStorageUnreferenced(ctx, args.storageId)) {
        await ctx.storage.delete(args.storageId);
      }
      await ctx.db.patch(op._id, { updatedAt: now });
      return { storageId: op.storageId };
    }
    // No canonical id yet, or the caller re-sent the same id: adopt it, again
    // only if unreferenced (the same defense applies).
    if (
      op.storageId === undefined &&
      !(await isStorageUnreferenced(ctx, args.storageId))
    ) {
      throw new Error("Storage object is already in use");
    }
    await ctx.db.patch(op._id, { storageId: args.storageId, updatedAt: now });
    return { storageId: args.storageId };
  },
});

export const finalizeImageImport = mutation({
  args: {
    operationId: v.string(),
    aspectRatio: v.optional(v.number()),
    isSticker: v.optional(v.boolean()),
    capturedAt: v.optional(v.number()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    spaceId: v.optional(v.id("spaces")),
  },
  returns: v.id("items"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    requireOperationId(args.operationId);

    const op = await loadImageOperation(ctx, userId, args.operationId);

    // Already complete — return the original live item id WITHOUT validating
    // the resubmitted metadata. The idempotent read path must not be gated on
    // the caller resending identical valid fields; a completed import is final.
    // (A complete row pointing at a deleted item should have been recycled by
    // begin; if we reach here, treat it as complete with the recorded id.)
    if (op !== null && op.status === "complete" && op.itemId !== undefined) {
      return op.itemId;
    }

    // Validate BEFORE touching the ledger: invalid metadata must not mark the
    // operation complete, so the caller can retry with corrected input.
    validateImageMetadata(args);

    if (op === null) {
      // The caller skipped begin (or the row was swept). We have no storageId
      // to attach, so this is an invalid import attempt.
      throw new Error("Operation has no attached upload");
    }
    if (op.storageId === undefined) {
      // begin succeeded but attach never ran (process died between upload and
      // attach). The narrow unreferenced-blob window the plan documents.
      throw new Error("Operation has no attached upload");
    }

    const itemId = await ctx.db.insert("items", {
      userId,
      type: "image",
      status: "processing",
      storageId: op.storageId,
      aspectRatio: args.aspectRatio,
      isSticker: args.isSticker,
      capturedAt: args.capturedAt,
      latitude: args.latitude,
      longitude: args.longitude,
      tags: [],
      searchText: "",
    });
    if (args.spaceId !== undefined) {
      await saveIntoSpace(ctx, userId, itemId, args.spaceId);
    }
    await ctx.db.patch(op._id, {
      status: "complete",
      itemId,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.ai.processItem, { itemId });
    return itemId;
  },
});

/** Read-only probe of an operation's server-side state. Used by client recovery
 * (e.g. plan 005's Tidy undo) to learn whether an operation completed. It MUST
 * NOT create, refresh, or patch a row and must not touch updatedAt — probing on
 * every launch through begin would create pending rows whose only exit is the
 * 24h cleanup and refresh their updatedAt, deferring cleanup indefinitely. */
export const getImportOperation = query({
  args: { operationId: v.string() },
  returns: v.union(
    v.object({
      status: v.union(v.literal("pending"), v.literal("complete")),
      itemId: v.optional(v.id("items")),
      storageId: v.optional(v.id("_storage")),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const op = await loadImageOperation(ctx, userId, args.operationId);
    if (op === null) {
      return null;
    }
    return {
      status: op.status,
      itemId: op.itemId,
      storageId: op.storageId,
    };
  },
});

/** Sweep a bounded page of pending image operations older than 24h: delete the
 * unreferenced attached upload (the blob the process never finalized), then the
 * ledger row. Complete rows stay as the permanent idempotency record. */
export const cleanupStaleImageImports = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = await ctx.db
      .query("itemOperations")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "pending").lt("updatedAt", cutoff),
      )
      .take(100);
    for (const op of stale) {
      if (op.kind !== "image") {
        // Plan 004/005 own link/note cleanup; leave non-image rows to them.
        continue;
      }
      if (op.storageId !== undefined) {
        await ctx.storage.delete(op.storageId);
      }
      await ctx.db.delete(op._id);
    }
    return null;
  },
});

export const createLinkItem = mutation({
  args: { url: v.string(), spaceId: v.optional(v.id("spaces")) },
  returns: v.id("items"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const url = normalizeUrl(args.url);
    if (url === "https://") {
      throw new Error("Invalid URL");
    }
    const itemId = await ctx.db.insert("items", {
      userId,
      type: "link",
      status: "processing",
      url,
      tags: [],
      searchText: "",
    });
    if (args.spaceId !== undefined) {
      await saveIntoSpace(ctx, userId, itemId, args.spaceId);
    }
    await ctx.scheduler.runAfter(0, internal.ai.processItem, { itemId });
    return itemId;
  },
});

export const createNoteItem = mutation({
  args: { text: v.string(), spaceId: v.optional(v.id("spaces")) },
  returns: v.id("items"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (args.text.trim() === "") {
      throw new Error("Note text is empty");
    }
    const itemId = await ctx.db.insert("items", {
      userId,
      type: "note",
      status: "processing",
      note: args.text,
      tags: [],
      searchText: "",
    });
    if (args.spaceId !== undefined) {
      await saveIntoSpace(ctx, userId, itemId, args.spaceId);
    }
    await ctx.scheduler.runAfter(0, internal.ai.processItem, { itemId });
    return itemId;
  },
});

/**
 * User-triggered product search ("Find links"). Explicit button = bounded
 * cost: one vision/text query + one SerpAPI call per press, never automatic.
 */
export const findLinks = mutation({
  args: { id: v.id("items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const item = await ctx.db.get(args.id);
    if (item === null || item.userId !== userId) {
      throw new Error("Item not found");
    }
    if (item.status !== "ready" || item.productsStatus === "searching") {
      return null;
    }
    await ctx.db.patch(item._id, { productsStatus: "searching" });
    await ctx.scheduler.runAfter(0, internal.ai.findProductLinks, {
      itemId: item._id,
    });
    return null;
  },
});

export const deleteItem = mutation({
  args: { id: v.id("items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const item = await ctx.db.get(args.id);
    if (item === null || item.userId !== userId) {
      throw new Error("Item not found");
    }
    const joins = await ctx.db
      .query("spaceItems")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .collect();
    for (const join of joins) {
      await ctx.db.delete(join._id);
    }
    // Release the import operation(s) that produced this item so a durable
    // operationId can be re-performed after an explicit delete (Tidy undo).
    // Pending rows have no itemId and are excluded by the index; this only
    // touches completed operations whose result was this item. AI processing
    // failures do NOT release the operation — the item still exists.
    const operations = await ctx.db
      .query("itemOperations")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .take(10);
    for (const op of operations) {
      await ctx.db.delete(op._id);
    }
    if (item.storageId) {
      await ctx.storage.delete(item.storageId);
    }
    await ctx.db.delete(item._id);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal — used by the AI actions
// ---------------------------------------------------------------------------

export const getItemInternal = internalQuery({
  args: { itemId: v.id("items") },
  returns: v.union(v.object(itemFields), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.itemId);
  },
});

export const listReadyItemsInternal = internalQuery({
  args: { userId: v.string(), limit: v.number() },
  returns: v.array(v.object(itemFields)),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(1, Math.floor(args.limit)), 200);
    const items = await ctx.db
      .query("items")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(limit * 2);
    return items.filter((item) => item.status === "ready").slice(0, limit);
  },
});

export const finalizeItem = internalMutation({
  args: {
    itemId: v.id("items"),
    title: v.string(),
    description: v.string(),
    tags: v.array(v.string()),
    content: v.optional(v.string()),
    siteName: v.optional(v.string()),
    heroImageUrl: v.optional(v.string()),
    aspectRatio: v.optional(v.number()),
    intents: v.optional(v.array(intentValidator)),
    status: itemStatusValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (item === null) {
      return null;
    }
    // Intents are actions, not descriptive text — deliberately kept out of
    // searchText so labels like "Open in X" don't skew search relevance.
    const searchText = buildSearchText({
      title: args.title,
      description: args.description,
      tags: args.tags,
      siteName: args.siteName,
    });
    await ctx.db.patch(args.itemId, {
      title: args.title,
      description: args.description,
      tags: args.tags,
      content: args.content,
      siteName: args.siteName,
      heroImageUrl: args.heroImageUrl,
      aspectRatio: args.aspectRatio,
      intents: args.intents,
      status: args.status,
      searchText,
    });
    return null;
  },
});

export const listImagesNeedingRatioInternal = internalQuery({
  args: {},
  returns: v.array(v.object({ _id: v.id("items"), storageId: v.id("_storage") })),
  handler: async (ctx) => {
    const items = await ctx.db.query("items").take(LIST_CAP);
    const out: { _id: Id<"items">; storageId: Id<"_storage"> }[] = [];
    for (const item of items) {
      if (
        item.type === "image" &&
        item.storageId !== undefined &&
        item.aspectRatio === undefined
      ) {
        out.push({ _id: item._id, storageId: item.storageId });
      }
    }
    return out;
  },
});

export const setAspectRatioInternal = internalMutation({
  args: { itemId: v.id("items"), aspectRatio: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (item === null) {
      return null;
    }
    await ctx.db.patch(args.itemId, { aspectRatio: args.aspectRatio });
    return null;
  },
});

export const setProductsInternal = internalMutation({
  args: {
    itemId: v.id("items"),
    products: v.optional(v.array(productValidator)),
    productsStatus: productsStatusValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (item === null) {
      return null;
    }
    await ctx.db.patch(args.itemId, {
      // On failure the previous results (if any) are kept; only the status
      // flips so the button can offer a retry.
      ...(args.products !== undefined ? { products: args.products } : {}),
      productsStatus: args.productsStatus,
    });
    return null;
  },
});

export const failItem = internalMutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (item === null) {
      return null;
    }
    await ctx.db.patch(args.itemId, { status: "failed" });
    return null;
  },
});

/**
 * The classifier's per-item output: which dynamic spaces this new save fits.
 * Writes are strictly `suggested`-only — rows the user owns (`saved`,
 * `dismissed`, or legacy status-less rows) are never created, changed, or
 * removed here, so the pipeline cannot clobber a user decision by
 * construction. Existing suggestions not in the new set are withdrawn.
 */
export const setSpacesForItem = internalMutation({
  args: {
    itemId: v.id("items"),
    spaceIds: v.array(v.id("spaces")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (item === null) {
      return null;
    }
    const wanted = new Set(args.spaceIds);
    const existing = await ctx.db
      .query("spaceItems")
      .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
      .collect();
    const touched = new Set<Id<"spaces">>();
    for (const join of existing) {
      touched.add(join.spaceId);
      if (effectiveStatus(join) === "suggested" && !wanted.has(join.spaceId)) {
        await ctx.db.delete(join._id);
      }
    }
    for (const spaceId of wanted) {
      // Any pre-existing row wins: already saved, already suggested, or
      // dismissed (the user said no — never re-suggest).
      if (touched.has(spaceId)) {
        continue;
      }
      const space = await ctx.db.get(spaceId);
      // Only suggest into dynamic spaces that exist and belong to the owner.
      if (
        space !== null &&
        space.userId === item.userId &&
        space.dynamic === true
      ) {
        await ctx.db.insert("spaceItems", {
          userId: item.userId,
          spaceId,
          itemId: args.itemId,
          status: "suggested",
        });
      }
    }
    return null;
  },
});

/**
 * The recommendation pass for one space (creation, or dynamic toggled on).
 * Same invariant as setSpacesForItem: suggested rows in, nothing else touched.
 */
export const suggestItemsForSpace = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    itemIds: v.array(v.id("items")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const space = await ctx.db.get(args.spaceId);
    if (space === null) {
      return null;
    }
    const existing = await ctx.db
      .query("spaceItems")
      .withIndex("by_space", (q) => q.eq("spaceId", args.spaceId))
      .collect();
    // Any existing row blocks a new suggestion — saved and dismissed are
    // user decisions, and a live suggestion needn't be re-written.
    const existingItemIds = new Set(existing.map((j) => j.itemId));
    const unique = [...new Set(args.itemIds)];
    for (const itemId of unique) {
      if (existingItemIds.has(itemId)) {
        continue;
      }
      const item = await ctx.db.get(itemId);
      if (item !== null && item.userId === space.userId) {
        await ctx.db.insert("spaceItems", {
          userId: space.userId,
          spaceId: args.spaceId,
          itemId,
          status: "suggested",
        });
      }
    }
    return null;
  },
});

