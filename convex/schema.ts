import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({
    userId: v.string(),
    type: v.union(v.literal("image"), v.literal("link"), v.literal("note")),
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    aspectRatio: v.optional(v.number()),
    capturedAt: v.optional(v.number()),
    // Where the photo was taken (signed decimal degrees, from EXIF GPS on
    // import). Always set together; absent for images without location data.
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    isSticker: v.optional(v.boolean()),
    tags: v.array(v.string()),
    content: v.optional(v.string()),
    siteName: v.optional(v.string()),
    heroImageUrl: v.optional(v.string()),
    note: v.optional(v.string()),
    // AI-proposed pressable actions. Optional so pre-existing rows validate
    // without a backfill. `kind` is a closed union (mirrors items.ts).
    intents: v.optional(
      v.array(
        v.object({
          kind: v.union(
            v.literal("open_url"),
            v.literal("copy"),
            v.literal("web_search"),
            v.literal("open_maps"),
            v.literal("call"),
            v.literal("email"),
            v.literal("message"),
            v.literal("add_event"),
          ),
          label: v.string(),
          value: v.string(),
        }),
      ),
    ),
    // Real product results from the user-triggered "Find links" pass
    // (SerpAPI Google Shopping). `productsStatus` tracks the in-flight action
    // so the button can show progress; absent = never searched.
    products: v.optional(
      v.array(
        v.object({
          title: v.string(),
          url: v.string(),
          price: v.optional(v.string()),
          merchant: v.optional(v.string()),
          thumbnailUrl: v.optional(v.string()),
        }),
      ),
    ),
    productsStatus: v.optional(
      v.union(
        v.literal("searching"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    searchText: v.string(),
  })
    .index("by_user", ["userId"])
    // Lets attachImageUpload confirm a client-supplied storage id is not
    // referenced by any completed item before deleting/adopting it, so a
    // malicious caller can't point attach at another user's storage object.
    .index("by_storage", ["storageId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["userId"],
    }),

  spaces: defineTable({
    userId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    // Dynamic = Amber keeps suggesting new saves into this space. Absent means
    // false (legacy spaces stay quiet until edited).
    dynamic: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  spaceItems: defineTable({
    userId: v.string(),
    spaceId: v.id("spaces"),
    itemId: v.id("items"),
    // The membership state machine. The AI may only ever write `suggested`
    // rows and only ever touch `suggested` rows; `saved` and `dismissed` are
    // user-owned, so the pipeline can never clobber a user decision.
    // Absent = legacy row = "saved".
    status: v.optional(
      v.union(
        v.literal("suggested"),
        v.literal("saved"),
        v.literal("dismissed"),
      ),
    ),
    // Purpose-steered actions scoped to THIS space's membership: the same
    // couch gets a shopping link in "apartment shopping" and nothing extra in
    // "interior design". Mirrors items.intents; kinds kept in sync with items.ts.
    intents: v.optional(
      v.array(
        v.object({
          kind: v.union(
            v.literal("open_url"),
            v.literal("copy"),
            v.literal("web_search"),
            v.literal("open_maps"),
            v.literal("call"),
            v.literal("email"),
            v.literal("message"),
            v.literal("add_event"),
          ),
          label: v.string(),
          value: v.string(),
        }),
      ),
    ),
  })
    .index("by_space", ["spaceId"])
    .index("by_item", ["itemId"])
    .index("by_user", ["userId"]),

  // Generic per-import idempotency ledger. One row per (userId, operationId),
  // where operationId is an opaque client-generated UUID. Plans 004/005 reuse
  // this table for link/note share and Tidy durability, so `kind` is closed
  // and kind-checked on every lookup; an operation ID reused with a different
  // kind is rejected rather than silently repurposed. The lifecycle is:
  //
  //   begin (pending) -> upload bytes -> attach storageId -> finalize (complete)
  //
  // `complete` rows are the permanent idempotency record — a retry reads the
  // same itemId back. `pending` rows older than 24h whose attached upload was
  // never finalized are swept by a bounded cleanup cron; their storage object
  // is deleted first. A completed row whose item was explicitly deleted is
  // recycled back to pending by beginImageImport, so a reissued durable
  // operationId performs a fresh save instead of returning a dead itemId.
  itemOperations: defineTable({
    userId: v.string(),
    operationId: v.string(),
    kind: v.union(v.literal("image"), v.literal("link"), v.literal("note")),
    status: v.union(v.literal("pending"), v.literal("complete")),
    storageId: v.optional(v.id("_storage")),
    itemId: v.optional(v.id("items")),
    updatedAt: v.number(),
  })
    // The logical unique key — every mutation loads the row through this index.
    .index("by_user_operation", ["userId", "operationId"])
    // deleteItem cleanup: releases ledger rows whose item was deleted so the
    // same durable operationId can be re-performed. Pending rows have no
    // itemId and so are never returned by this index lookup.
    .index("by_item", ["itemId"])
    // Lets isStorageUnreferenced see storage held by pending operations (an
    // uploaded-but-unfinalized blob), not just storage referenced by items —
    // otherwise the same blob could be adopted into two operations and later
    // deleted out from under a live item.
    .index("by_storage", ["storageId"])
    // Stale-pending cleanup cron, bounded per run. kind leads so the sweep
    // pages through image rows only and can't be starved by stale link/note
    // rows once plans 004/005 create them.
    .index("by_kind_status_updated", ["kind", "status", "updatedAt"]),
});
