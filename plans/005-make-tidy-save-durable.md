# Plan 005: Make Tidy saves durable

> **Executor instructions**: Complete plan 003 first. Follow each step and
> verification gate. A swipe animation may remain optimistic, but persistent
> reviewed state must never claim an image was saved before the backend confirms
> an item. Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- src/lib/tidy/storage.ts src/lib/tidy/use-tidy-actions.ts src/lib/tidy/use-photo-batch.ts src/lib/tidy/save-photo.ts src/lib/tidy/use-tidy-save-recovery.ts 'src/app/(app)/(tabs)/(tidy)/index.tsx' src/components/tidy/tidy-done.tsx src/lib/tidy/use-tidy-actions.test.ts src/lib/tidy/storage.test.ts`
> Plan 003 is expected to change `use-tidy-actions.ts` to consume settled image
> results. Rebase on that completed work and verify the current single-image
> adapter still maps success to item ID and failure to null. Unexpected drift is
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/003-make-image-imports-retry-safe.md`
- **Category**: bug
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

Tidy currently marks a photo reviewed before URI resolution, upload, and item
creation. A caught error can unmark it, but process termination cannot, so a
photo may disappear from Tidy even though Amber never saved it. This plan stores
a recoverable pending save, uses plan 003's operation ID across restarts, and
marks reviewed only after confirmed item creation while preserving immediate
swipe feedback and undo.

## Current state

- `src/lib/tidy/storage.ts` stores only `reviewed:<assetId>` booleans and selected
  album ID. There is no pending/recovery state.
- `use-tidy-actions.ts:59-83` resolves the asset URI/location and calls the shared
  image saver. Its catch logs, unmarks reviewed, and returns null.
- `use-tidy-actions.ts:103-107` calls `markReviewed([photo.id])` and increments
  `saved` before `startSave` begins.
- Undo lines 132-141 unmark immediately and chain item deletion after the upload
  promise. It has no durable cancellation marker.
- `use-photo-batch.ts:73-76` filters only `isReviewed`; it knows nothing about
  pending saves.
- `TidyDone` can show completed counts/loading but has no pending-save or failed-
  save action.
- Plan 003 supplies per-image settled results, stable caller-provided operation
  IDs, idempotent finalize, and operation release on `deleteItem`. Its cleanup
  cron only deletes *pending* (unfinalized) operations and their attached
  storage; it never reaps `complete` rows. So a Tidy recovery that runs days
  later is safe: if its ledger row was reaped, the save simply re-runs cleanly,
  and a completed save's idempotency record always survives.

## Required lifecycle

```text
swipe save
  -> persist pending(photo metadata + operationId)
  -> animate card away
  -> resolve/upload/finalize with same operationId
       success -> mark reviewed + remove pending + increment confirmed saved
       failure -> retain failed/retry state; never mark reviewed
       undo    -> mark pending cancelled; late success deletes item

app relaunch
  -> load pending records before photo batch
  -> retry each with same operationId
       backend already completed -> return same item -> mark reviewed
       retry fails -> expose retry or release photo back into batch
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `bun run test -- src/lib/tidy/storage.test.ts src/lib/tidy/use-tidy-actions.test.ts` | exits 0, lifecycle cases pass |
| Typecheck | `bun run typecheck` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Suggested executor toolkit

- Read SDK 57 Media Library docs before relying on `Asset.getUri()` during
  recovery: `https://docs.expo.dev/versions/v57.0.0/sdk/media-library/`.
- Use `testing-guidelines`; keep workflow logic behind injected storage/save/
  delete dependencies so tests do not require Photos, MMKV native code, or a
  live Convex deployment.

## Scope

**In scope**:
- `src/lib/tidy/storage.ts`
- `src/lib/tidy/use-tidy-actions.ts`
- `src/lib/tidy/use-photo-batch.ts`
- `src/lib/tidy/save-photo.ts` (create if needed for shared save/recovery logic)
- `src/lib/tidy/use-tidy-save-recovery.ts` (create if needed)
- `src/app/(app)/(tabs)/(tidy)/index.tsx`
- `src/components/tidy/tidy-done.tsx`
- `src/lib/tidy/storage.test.ts` (create)
- `src/lib/tidy/use-tidy-actions.test.ts` (create)
- `plans/README.md`

**Out of scope**:
- Native deletion queue/confirmation behavior; plan 006 owns it.
- Changing the deck gesture or animation model.
- Background execution when the app is not running. Recovery occurs when Tidy
  next mounts/focuses.
- Global image import changes beyond plan 003's existing contract.

## Git workflow

- Branch: `advisor/005-durable-tidy-saves`
- Prefer commits for persistent state/recovery, action orchestration, then UI/tests.
- Use imperative commit subjects and do not push/open a PR unless instructed.

## Steps

### Step 1: Version and persist pending Tidy saves

Extend the dedicated Tidy MMKV store with a versioned pending-save record per
asset. It must contain only restart-safe data:

- asset ID, width, height, creation time;
- stable operation ID generated once at swipe time;
- state `pending`, `failed`, or `cancelled` (do not persist raw promises or
  raw errors). A `failed` record makes a failed save durable across restart
  and carries only sanitized failure data: the stage, a short sanitized
  message, and an attempt count;
- timestamp for diagnostics/recovery ordering.

Add focused functions such as begin/read/list/complete/cancel pending save. Keep
the reviewed boolean source of truth unchanged, but make completion order
explicit: set reviewed first and then remove pending (a crash between them is
safe because recovery sees already reviewed). A pending record must not itself
be reported by `isReviewed`.

Do not store transient file URIs; resolve from `new Asset(assetId).getUri()` on
each attempt because content/file URIs may not survive a restart.

**Verify**: storage tests with an in-memory MMKV adapter cover begin, list,
complete, cancel, legacy reviewed keys, and a simulated crash between reviewed
write and pending removal.

### Step 2: Share one save implementation between live actions and recovery

Extract the existing URI/location/mime/image-metadata assembly into
`save-photo.ts` only if both live save and recovery consume it. It receives a
`TidyPhoto`, stable operation ID, and plan 003 save function, then returns the
settled result. Preserve best-effort location lookup: location failure must not
fail the save.

Create recovery orchestration that runs before the first photo batch query when
Tidy mounts with permission:

- list pending records;
- skip/clean records already marked reviewed;
- for active records, call the shared saver with the existing operation ID;
- on success, complete the reviewed transition;
- on failure, mark the durable record `failed` so it survives restart and
  stays visible for user retry; never auto-retry continuously;
- on a cancelled record, call plan 003's read-only
  `getImportOperation({ operationId })` to learn whether the save completed
  server-side; never use `beginImageImport` as the probe (it creates/refreshes a
  backend row). If it returned `complete` with an `itemId`, delete that item
  (plan 003 makes `deleteItem` release the ledger) and then remove the pending
  record; if `pending`/`null`, just remove the cancelled pending record.

Expose `recovering`, failed count, `retryFailed`, and an explicit
`releaseFailedToDeck` action. Releasing removes pending without marking reviewed,
so the photo can reappear on a reset query.

**Verify**: orchestration tests simulate backend already-complete, upload
failure, finalize failure, and process restart; each operation ID must remain
unchanged.

### Step 3: Commit reviewed state only after save success

Refactor the save branch in `use-tidy-actions.ts`:

- persist pending before starting async work;
- keep moving `topIndex` immediately so swipe animation remains responsive;
- do not call `markReviewed` or increment confirmed `saved` on decision;
- on settled success, complete pending → reviewed and increment `saved` once;
- on failure, retain a failed entry exposed to the Done UI and leave reviewed
  false;
- prevent duplicate taps/retries from starting a second promise for one
  operation.

Track pending promise/count separately from confirmed counts. Batch completion
may render while saves are pending, but Continue must not silently abandon them.

**Verify**: tests assert reviewed remains false while deferred save is pending,
becomes true only on success, stays false on both upload and finalize failure,
and saved count increments exactly once after ambiguous-response retry.

### Step 4: Make undo safe before and after completion

For an undone save:

- immediately mark its pending record cancelled and restore the card/count UI;
- if the save later fails, remove the cancelled pending record;
- if it later succeeds, call authenticated `deleteItem`, which plan 003 makes
  release the operation ledger, and only after it succeeds remove
  reviewed/pending state;
- if completion already happened, delete the item first (only through
  authenticated `deleteItem`, which also clears the operation), and only after
  the delete succeeds unmark reviewed and remove the recovery record. If the
  `itemId` is unknown because the in-flight promise was lost across a lifecycle
  transition, resolve it with plan 003's read-only `getImportOperation` — never
  `beginImageImport`;
- a failed delete must preserve (or restore) the reviewed state and the
  recovery record and surface the error, so the undo can be retried — never
  discard the record or leave the photo back in the deck while its item still
  exists.

The async completion callback must check current cancellation state from durable
storage, not only a closure boolean, so an app lifecycle transition cannot turn
an undone save into reviewed.

**Verify**: tests cover undo before upload resolves, undo immediately after
finalize, delete failure followed by recovery retry, and a late success racing
undo. Final state is one of: item exists+reviewed, or no item+not reviewed; never
the mismatched combinations.

### Step 5: Gate the deck and expose retry choices

In Tidy screen/index and `TidyDone`:

- run recovery before enabling `usePhotoBatch`; show a loading state while it
  executes so pending photos are not simultaneously dealt into the deck;
- when batch saves are still pending, show “Saving N…” and disable Continue;
- on failed saves, show `Retry failed` and `Return to Tidy` (release failed
  photos and reset/reload the batch); state clearly that they were not saved;
- permit Continue only when every save is either confirmed, undone, or
  explicitly released back to the deck.

`use-photo-batch.ts` may exclude pending records while recovery owns them, but
must include released/failed records after a reset. Avoid advancing past a
pending asset with no recovery UI.

**Verify**: `bun run check` → exit 0; manual screen test shows no Continue button
can abandon a pending/failed save.

## Test plan

- Storage: versioned read/write, legacy reviewed compatibility, completion crash
  ordering, cancelled record retention.
- Action orchestration: success, URI failure, upload failure, item-finalize
  failure, duplicate retry, pending count, confirmed count.
- Undo: in-flight, just-completed, deletion failure, late completion race.
- Recovery: restart before upload, after upload attachment, after backend
  finalize/before local review, already-reviewed stale pending.
- Manual: kill the app during an upload, relaunch Tidy, and confirm exactly one
  Amber item and correct reviewed state.
- Verification: focused tests and `bun run check` pass.

## Done criteria

- [ ] `markReviewed` for save occurs only after confirmed item creation.
- [ ] Every pending save is durable and reuses one plan-003 operation ID.
- [ ] Process restart reconciles a late/ambiguous success without duplicates.
- [ ] Failed saves are visible and retryable or explicitly returned to the deck.
- [ ] Undo yields consistent backend/local state across timing races.
- [ ] Continue cannot abandon unresolved saves.
- [ ] Focused tests and `bun run check` pass.
- [ ] Native delete behavior is unchanged for plan 006.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Plan 003's image operations are not idempotent or `deleteItem` does not release
  the operation ledger.
- `Asset.getUri()` cannot resolve a persisted asset ID after relaunch on a
  supported platform; recovery design must then be revised, not guessed.
- A proposed fix marks pending as reviewed merely to hide it from pagination.
- Undo cannot retain a durable recovery marker when backend deletion fails.
- Implementing recovery requires background-task infrastructure or a file
  outside scope.
- Any verification fails twice after a focused correction.

## Maintenance notes

- Version pending-save records and keep migration conservative: unknown versions
  should return photos to the deck rather than mark them reviewed.
- Reviewers should trace each state transition across MMKV, operation ledger,
  item row, counts, and deck visibility.
- Plan 006 edits the same action hook; preserve these save invariants while
  changing deletion commit behavior.
