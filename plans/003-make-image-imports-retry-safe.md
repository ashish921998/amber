# Plan 003: Make image imports idempotent and retry-safe

> **Executor instructions**: Follow this plan step by step and run every
> verification gate. Stop on any condition in "STOP conditions"; do not replace
> the design with an all-or-nothing `Promise.all` retry. Update this plan's row
> in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- package.json bun.lock convex/schema.ts convex/items.ts convex/crons.ts src/lib/use-save-image.ts 'src/app/(app)/add.tsx' 'src/app/(app)/camera.tsx' 'src/app/(app)/share.tsx' src/lib/tidy/use-tidy-actions.ts convex/items.test.ts src/lib/use-save-image.test.ts`
> Plan 001 is expected to change package files and add the test runner. Rebase
> this plan on completed plan 001, then compare every other changed in-scope
> file with the excerpts below. Unexpected behavior drift is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-establish-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

`useSaveImages` uploads and creates each item concurrently under one
`Promise.all`. If one image fails, callers report that the whole batch failed
even though other items may already exist; retrying the batch duplicates those
successes. An upload that succeeds before item creation fails can also become
unreferenced storage. This plan gives each image a stable operation ID, records
its backend lifecycle, returns per-image outcomes, and cleans up known abandoned
uploads without claiming impossible cross-network atomicity.

## Current state

- `src/lib/use-save-image.ts:37-63` maps images through `Promise.all`. Each task
  requests an upload URL, posts a file, then calls `createImageItem`.
- A single rejection discards all successful IDs from the caller's perspective.
- `convex/items.ts:295-354` exposes independent `generateUploadUrl` and
  `createImageItem` mutations with no operation key or retry ledger.
- `createImageItem` inserts the item, optionally inserts a space membership,
  schedules AI processing, and returns an ID. There is no deduplication.
- `convex/schema.ts` has only `items`, `spaces`, and `spaceItems` tables.
- Multi-image callers are `add.tsx`, `camera.tsx`, and `share.tsx`; Tidy calls
  the same API with one image. Plans 004 and 005 will add stronger recovery to
  Share and Tidy, so this plan must leave those callers compiling and expose the
  stable contract they need.
- `expo-crypto` exists transitively but is not a direct dependency. Use the SDK
  57 package through `bunx expo install expo-crypto` rather than relying on a
  transitive install.
- Convex mutations are transactional for database writes, but the client upload
  occurs outside that transaction. The correct goal is idempotency plus
  compensation, not fictional atomic upload+mutation semantics.

## Target contract

Use one generic backend operation ledger so plan 004 can reuse it for shared
links and notes:

```ts
type ImageSaveResult =
  | { status: 'saved'; operationId: string; image: LocalImage; itemId: Id<'items'> }
  | { status: 'failed'; operationId: string; image: LocalImage; stage: 'begin' | 'upload' | 'attach' | 'finalize'; message: string };
```

`saveImages` resolves with one result per input, in input order. Per-image
failures are data, not a rejected whole-batch promise. A caller retries only
failed results and passes their existing `operationId`; it never generates a
new ID for a retry.

The backend lifecycle is:

```text
begin operation -> upload bytes -> attach storage ID -> finalize item
                         |                 |
                         |                 +-> pending row enables cleanup/retry
                         +-> tiny unavoidable crash window before attach
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Read Convex rules | `cat convex/_generated/ai/guidelines.md` | exits 0; read before edits |
| Install Expo package | `bunx expo install expo-crypto` | exits 0; package and lock updated |
| Focused tests | `bun run test -- convex/items.test.ts src/lib/use-save-image.test.ts` | exits 0, all import tests pass |
| Full gate | `bun run check` | exits 0 |

## Suggested executor toolkit

- Read `convex/_generated/ai/guidelines.md` first; its function syntax, validators,
  indexes, and cron rules override remembered Convex patterns.
- Read SDK 57 FileSystem, Fetch, and Crypto docs under
  `https://docs.expo.dev/versions/v57.0.0/` before changing client upload code.
- Use `testing-guidelines` if available. Tests must use deterministic fake upload
  responses and `convex-test`, never real storage or internet.

## Scope

**In scope**:
- `package.json`
- `bun.lock`
- `convex/schema.ts`
- `convex/items.ts`
- `convex/crons.ts` (create if cleanup uses a cron)
- `src/lib/use-save-image.ts`
- `src/app/(app)/add.tsx`
- `src/app/(app)/camera.tsx`
- `src/app/(app)/share.tsx` only for compatibility with the new result type
- `src/lib/tidy/use-tidy-actions.ts` only for compatibility with the new result type
- `convex/items.test.ts` (create)
- `src/lib/use-save-image.test.ts` (create)
- `plans/README.md`

**Out of scope**:
- The full incoming-share state machine; plan 004 owns it.
- Durable Tidy reviewed/pending state; plan 005 owns it.
- Changing AI item processing after item creation.
- Content-hash deduplication across separate user actions. Idempotency is scoped
  to one explicit operation ID; users may intentionally save the same image in
  two different operations.
- Guaranteeing cleanup if the process dies after upload but before the storage
  ID is attached. Document this narrow gap; do not claim it is eliminated.

## Git workflow

- Branch: `advisor/003-retry-safe-image-imports`
- Prefer three reviewable commits: backend ledger, client result contract, caller
  UI/tests. Use imperative subjects matching repository history.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a generic item-operation ledger

In `convex/schema.ts`, add `itemOperations` with:

- `userId: string`
- `operationId: string`
- `kind: "image" | "link" | "note"`
- `status: "pending" | "complete"`
- optional `storageId` and `itemId`
- `updatedAt: number`
- indexes `by_user_operation` on `[userId, operationId]`, `by_item` on
  `[itemId]`, and a cleanup index on `[status, updatedAt]`.

Operation IDs are opaque client-generated UUIDs with a caller prefix for logs;
enforce a reasonable non-empty length bound (for example 8-200 characters) in
mutations. `(userId, operationId)` is the logical unique key. Every mutation
must query that index and reject a kind mismatch.

Add internal helpers in `convex/items.ts` to load/create the operation. Do not
export raw ledger mutation capability to clients.

**Verify**: `bun run typecheck` → exit 0; the generated API may update during
normal Convex dev/codegen, but do not hand-edit `convex/_generated/*`.

### Step 2: Implement begin, attach, finalize, and cleanup mutations

Replace the image path's two-step public contract with these authenticated
operations in `convex/items.ts`:

1. `beginImageImport({ operationId })` creates/refreshes a pending image
   operation and returns either an existing completed `itemId` or a fresh upload
   URL. A completed operation whose item was explicitly deleted is recyclable;
   see step 3. (If an operation attached but failed to finalize, a retry gets a
   fresh upload URL and re-uploads; `attach` then deletes the redundant blob and
   keeps the canonical storage ID. This re-upload is correct-by-design — do not
   'optimize' it ad hoc; leave it for a follow-up plan if it ever matters.)
2. `attachImageUpload({ operationId, storageId })` records the uploaded storage
   ID on the user's pending image operation. First attachment wins. If a racing
   retry supplies a different storage ID, delete that redundant upload and
   return the canonical ID instead of replacing it.
3. `finalizeImageImport({ operationId, metadata..., spaceId? })` reads the
   attached storage ID, validates aspect ratio/location/space before insertion,
   and atomically inserts the item, optional saved membership, operation result,
   and scheduler job. If already complete, return the original live item ID.

Also add an authenticated **read-only** query
`getImportOperation({ operationId })` →
`{ status: "pending" | "complete"; itemId?: Id<"items">; storageId?: Id<"_storage"> } | null`.
It must never create, refresh, or patch a ledger row and must not touch
`updatedAt`. It exists so client recovery/undo (plan 005) can learn whether an
operation completed server-side. **Do not substitute `beginImageImport` for this
probe:** on a non-complete operation `begin` creates a pending row whose only
exit is the 24h cleanup cron and refreshes `updatedAt`, which can defer that
cleanup indefinitely if a client probes on every launch.

Keep validation and `saveIntoSpace` ownership rules equivalent to the current
`createImageItem`. Remove or make private the old public entry points only after
all callers migrate; do not leave two non-idempotent creation paths.

Add an internal cleanup mutation that deletes storage attached to pending image
operations older than 24 hours, then deletes those ledger rows. Register it in
`convex/crons.ts` with `crons.interval` as required by the Convex guidelines.
Process a bounded page per run; never scan unbounded rows. Complete rows remain
as the idempotency record.

**Verify**: focused Convex tests must prove same-operation finalize returns one
item, racing attachment retains one canonical storage ID, and stale pending
cleanup never deletes storage referenced by a completed item.

### Step 3: Make explicit item deletion release its operation

Update `deleteItem` so, in the same authenticated mutation that deletes the
item, it queries `itemOperations.by_item` and deletes ledger rows pointing at
that item. This matters for Tidy undo: an explicitly deleted save may later be
performed again with the same durable operation ID.

Do not delete an operation merely because AI processing failed; the image item
still exists and is the completed import result.

**Verify**: add a Convex test: finalize operation → delete item → begin same
operation → result is pending/new upload, not a stale deleted item ID.

### Step 4: Return settled per-image client results

In `src/lib/use-save-image.ts`:

- Add optional `operationId` to the input used for retries, or define a separate
  `ImageSaveRequest` that pairs `LocalImage` with it. Keep `LocalImage` itself a
  description of the file, not mutable status.
- Generate a UUID with `expo-crypto.randomUUID()` only when the request has no
  operation ID. Prefixing (for example `image:`) is allowed but the UUID must
  remain the stable portion.
- For each image, call begin → upload → attach → finalize. If begin reports an
  existing item, return `saved` without uploading.
- Catch errors inside each mapped task and return the failed result/stage.
  `Promise.all` may still preserve concurrency because tasks no longer reject.
- Keep results in input order and sanitize `message`; do not expose upload URLs,
  storage IDs, or backend stack traces to UI.
- Export the orchestration as a testable function receiving begin/upload/attach/
  finalize dependencies; keep `useSaveImages` as the thin React/Convex adapter.

**Verify**: client tests with fakes cover all stages and `bun run typecheck`
exits 0.

### Step 5: Update callers to handle exact outcomes

- `add.tsx` and camera library import: close/navigate only when every image is
  saved. On partial failure, report `N of M saved`, retain only failed requests
  with their operation IDs, and offer `Retry failed` plus `Done`. A retry must
  not resubmit successful requests.
- Single camera capture/sticker: inspect its single result and preserve the
  current failure alert; reuse the result operation ID if the user retries in
  the same screen.
- `share.tsx`: minimally consume settled results and treat any failed image as a
  failure so it compiles. Do not add the full retry UI or clear-policy change;
  plan 004 replaces this flow.
- `use-tidy-actions.ts`: for the single image, map `saved` to its `itemId` and
  `failed` to `null`, preserving current behavior until plan 005.

Avoid a generic global upload store. State belongs to the initiating screen or
to the durable workflows in plans 004/005.

**Verify**: `bun run check` → exit 0.

## Test plan

`convex/items.test.ts` using `convex-test`:

- first finalize creates one image item and schedules processing;
- repeated begin/finalize with the same user+operation returns the same item;
- the same operation ID for another user is independent;
- reusing one operation ID with a different kind is rejected;
- two attachment attempts keep one canonical storage ID and discard the other;
- invalid metadata/space does not mark the operation complete;
- explicit item deletion releases the operation;
- stale pending cleanup deletes only eligible unreferenced uploads.

`src/lib/use-save-image.test.ts` with injected fakes:

- all success preserves input order;
- one upload failure does not hide sibling successes;
- retry submits only failed operation IDs;
- ambiguous finalize response followed by retry returns the existing item;
- begin-complete skips upload;
- attach/finalize failures report the correct stage.

Verification: focused test command → all named cases pass; `bun run check` →
full suite passes.

## Done criteria

- [ ] Every image attempt has one stable operation ID reused on retry.
- [ ] Backend creates at most one live item per user+operation.
- [ ] Public callers cannot use the old non-idempotent image creation path.
- [ ] One image failure cannot erase sibling success information.
- [ ] Add and Camera retry only failed images and report partial outcomes.
- [ ] Known stale attached uploads are cleaned by a bounded job.
- [ ] The pre-attach crash window is documented, not falsely described as atomic.
- [ ] Focused tests and `bun run check` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Convex storage mutations cannot safely delete a redundant/stale storage ID
  from the authenticated operation flow.
- Implementing cleanup would allow one user to delete another user's completed
  storage object.
- The operation uniqueness assumption cannot be enforced transactionally with
  the planned index/mutation pattern.
- A proposed implementation retries the whole batch with fresh IDs or claims
  upload+DB atomicity.
- Plan 001 is not green, a required API differs from the current Convex
  guidelines, or any verification fails twice.

## Maintenance notes

- Plan 004 reuses `itemOperations` for link/note share idempotency; keep the
  table generic and kind-checked.
- Plan 005 supplies durable operation IDs for Tidy. Do not make this hook itself
  persist screen workflow state.
- Monitor pending-operation cleanup counts; growth indicates clients are dying
  between upload and finalize.
