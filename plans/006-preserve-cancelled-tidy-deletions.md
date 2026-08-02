# Plan 006: Preserve Tidy deletions when confirmation fails

> **Executor instructions**: Complete plan 005 first. Follow this plan step by
> step and run every verification. Never advance to the next media page after a
> deletion rejection/cancellation. Update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- src/lib/tidy/use-tidy-actions.ts src/lib/tidy/use-photo-batch.ts 'src/app/(app)/(tabs)/(tidy)/index.tsx' src/components/tidy/tidy-done.tsx src/lib/tidy/use-tidy-actions.test.ts`
> Plan 005 intentionally changes every path above except possibly
> `use-photo-batch.ts`. Confirm plan 005 is DONE and map this plan onto its save
> lifecycle. Do not overwrite durable save/recovery behavior. Drift from any
> other source is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/005-make-tidy-save-durable.md`
- **Category**: bug
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

Tidy clears its delete queue and undo history before the native Photos deletion
finishes, then Continue loads the next batch regardless of success. If the user
cancels iOS confirmation or deletion fails, those photos stay on-device but can
be skipped by the already-advanced media offset for the rest of the session.
This plan makes commit transactional from the workflow's perspective: only a
confirmed native success consumes the queue, updates counts/offsets, and permits
pagination.

## Current state

- `use-tidy-actions.ts:151-170` snapshots the queue by reference, immediately
  empties `pendingDeletesRef` and all history, then calls `Asset.delete`.
- On success it marks assets reviewed, subtracts the deleted count from paging
  offset, and increments `deleted`; on rejection it only logs.
- `index.tsx:116-123` awaits `commitDeletes` and always calls
  `loadNextBatch()` because `commitDeletes` returns no outcome and swallows the
  error.
- `index.tsx:97-105` calls `commitDeletes()` fire-and-forget from focus cleanup,
  which can launch a system confirmation while the user is leaving and gives no
  UI for cancellation/failure.
- `use-photo-batch.ts:48-70` advances `offsetRef` as pages are read. It only
  compensates through `noteDeleted(count)` after success.
- Installed Expo Media Library 57 uses
  `PHPhotoLibrary.performChanges { PHAssetChangeRequest.deleteAssets(...) }` on
  iOS and rejects the promise when the operation does not complete. Treat any
  rejection as “not confirmed deleted”; do not infer success.
- Plan 005 may have added pending-save/recovery UI to the same Done screen. This
  plan must compose with it rather than replace it.

## Required commit contract

```ts
type DeleteCommitResult =
  | { status: 'nothing'; count: 0 }
  | { status: 'deleted'; count: number }
  | { status: 'not-deleted'; count: number; reason: 'cancelled' | 'failed' };
```

If the native bridge does not expose a stable cancellation code on both
platforms, use `reason: 'failed'` for unknown rejections. The critical
distinction is confirmed deleted vs not deleted; never parse localized error
messages to manufacture a cancellation classification.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `bun run test -- src/lib/tidy/use-tidy-actions.test.ts` | exits 0, delete cases pass |
| Full gate | `bun run check` | exits 0 |
| Focus cleanup scan | `rg -n 'useFocusEffect|commitDeletes\(\);' 'src/app/(app)/(tabs)/(tidy)/index.tsx'` | no fire-and-forget delete cleanup remains |

## Suggested executor toolkit

- Read SDK 57 Media Library docs and the installed iOS/Android implementation;
  do not assume behavior from older Expo APIs.
- Use the existing injected orchestration seam from plan 005 for deterministic
  delete promises. Tests must not open native confirmation dialogs.

## Scope

**In scope**:
- `src/lib/tidy/use-tidy-actions.ts`
- `src/lib/tidy/use-photo-batch.ts`
- `src/app/(app)/(tabs)/(tidy)/index.tsx`
- `src/components/tidy/tidy-done.tsx`
- `src/lib/tidy/use-tidy-actions.test.ts` from plan 005
- `plans/README.md`

**Out of scope**:
- Durable save/recovery behavior from plan 005.
- Replacing Expo Media Library or writing a custom Photos deletion module.
- Automatically treating a rejected delete as Keep.
- Persisting the delete queue across app termination. If the screen unmounts,
  uncommitted deletes remain unreviewed and safely resurface on a future
  offset-reset session.
- Bypassing or suppressing iOS system confirmation.

## Git workflow

- Branch: `advisor/006-transactional-tidy-delete`
- Use one imperative commit such as `Keep Tidy deletes pending until confirmation`.
- Do not push/open a PR unless instructed.

## Steps

### Step 1: Return a typed commit outcome and lock concurrent commits

Refactor `commitDeletes` in `use-tidy-actions.ts`:

- return the `DeleteCommitResult` union above;
- copy the current queue into an immutable snapshot but do not clear queue,
  history, pending count, or undo state before awaiting native deletion;
- expose `deleting` and reject/coalesce a second commit while one is in flight;
- if the queue is empty, return `nothing` without native work;
- on resolved native deletion, remove exactly the snapshot entries, clear the
  now-committed history boundary, mark those asset IDs reviewed, call
  `noteDeleted(snapshot.length)`, increment count, and return `deleted`;
- on rejection, leave queue/history/counts/reviewed state unchanged and return
  `not-deleted` with a safe reason.

If new delete decisions can be queued while native confirmation is visible,
retain those newer entries after success. Do not assign `[]` indiscriminately.

**Verify**: tests with deferred promises assert every observable value before
resolve, after resolve, and after reject/cancel.

### Step 2: Advance media pagination only after confirmed deletion

Update `handleContinue` in Tidy index:

- await `commitDeletes`;
- call `loadNextBatch()` only for `deleted` or `nothing`;
- for `not-deleted`, remain on the Done state with queue/count/undo intact and
  show actions `Try delete again` and `Review decisions`/Undo;
- disable Continue and toolbar delete while `deleting` is true;
- do not place `loadNextBatch` in a `finally` block.

No `noteDeleted` call occurs on rejection, so the current offset remains valid
while the same batch remains mounted. If the user leaves, a future Tidy mount
resets offset to zero and the unreviewed assets resurface.

**Verify**: test screen coordinator or extracted handler: rejection produces
zero `loadNextBatch`/`noteDeleted` calls; success produces one of each with exact
count.

### Step 3: Remove fire-and-forget deletion on focus cleanup

> ⚠ **Operator signoff required.** This step is a product behavior change:
> leaving Tidy with queued-but-uncommitted deletes silently drops that delete
> session (the photos resurface in a future batch) instead of prompting.
> Confirm the operator has accepted that tradeoff before implementing.

Delete the `useFocusEffect` cleanup that launches `commitDeletes` during blur.
Native confirmation requires an active, visible workflow that can explain the
outcome. On navigation away, do not mark queued assets reviewed; hook unmount
may discard the in-memory queue, and those assets safely return in a future
session.

If product requires a leave warning later, implement it as a separate navigation
guard plan. Do not block this fix on custom back interception.

**Verify**: focus cleanup scan returns no fire-and-forget call; `bun run lint`
has no now-unused imports.

### Step 4: Preserve all plan-005 save invariants

Re-run plan 005's focused suite after delete changes. Confirm:

- in-flight save still blocks Continue independently of delete status;
- save failure/retry UI coexists with delete failure/retry UI;
- clearing history after successful delete does not cancel or forget durable
  save recovery records;
- undo before delete commit still removes the most recent queued delete;
- after successful delete, decisions before the commit boundary are correctly
  non-undoable.

If the single LIFO history cannot express “committed delete but unresolved save,”
split delete queue history from save recovery state; do not clear durable save
state to simplify undo.

**Verify**: focused Tidy tests and `bun run check` pass.

### Step 5: Verify native confirmation behavior

On iOS:

1. queue at least two deletes and tap Delete/Continue;
2. cancel the system confirmation;
3. confirm the same queue/count and retry actions remain;
4. retry and approve; confirm assets disappear, count increments once, and next
   batch does not skip an unseen photo.

On Android, exercise approval and denial/failure paths supported by the device
version. Also navigate away with queued but uncommitted deletes, return to Tidy,
and confirm assets remain on-device and eventually resurface.

**Verify**: document iOS and Android outcomes in PR notes. Count increments,
reviewed flags, and offset compensation must occur only on confirmed success.

## Test plan

- Empty queue returns `nothing` and makes no native call.
- Deferred native call leaves queue/history/counts intact.
- Success commits exact snapshot once and calls `noteDeleted` once.
- Rejection/cancellation commits nothing and permits retry.
- Double tap creates one native request.
- Continue advances only on `deleted`/`nothing`.
- Undo works after cancellation; durable save tests from plan 005 remain green.
- Manual iOS confirmation cancellation and Android behavior from step 5.

## Done criteria

- [ ] Queue/history are not cleared before native success.
- [ ] Rejected/cancelled deletion remains visible and retryable.
- [ ] Continue never loads a new batch after `not-deleted`.
- [ ] `noteDeleted`, reviewed markers, and deleted count update only on success.
- [ ] No deletion prompt is launched from focus cleanup.
- [ ] Concurrent commit is prevented/coalesced.
- [ ] Plan 005 save/recovery tests and all new delete tests pass.
- [ ] `bun run check` passes.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Plan 005 is not complete or its save state is lost by the proposed history
  changes.
- The installed native API resolves success before user confirmation or can
  partially delete without exposing which assets succeeded.
- Product requires advancing after cancellation without deciding what the
  undeleted photos should become.
- A reliable cancelled-vs-failed distinction would require localized message
  parsing; use generic `failed` instead.
- Any verification fails twice after a focused correction.

## Maintenance notes

- Treat the native promise as the commit boundary. No future refactor should
  move durable/UI state updates before it.
- If Expo later exposes per-asset partial results, extend the result union and
  commit only returned IDs; do not assume all-or-none then.
- Reviewers should specifically inspect every `finally` and focus cleanup in the
  Tidy route for accidental advancement or unobserved async work.
