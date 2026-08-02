# Plan 008: Keep optional AI enrichment from failing ready items

> **Executor instructions**: Complete plan 007 first because both plans edit
> `convex/ai.ts`. Follow every step and verification. The core ready/failed
> status must be decided exactly once; optional space enrichment may log/retry
> but may never downgrade a ready item. Update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- convex/ai.ts convex/items.ts convex/spaces.ts convex/schema.ts convex/model/process-item.ts convex/items.test.ts convex/model/process-item.test.ts`
> Plan 007 intentionally changes fetch helpers/calls inside `convex/ai.ts` and
> plans 003/004 may change item creation/deletion. Confirm those plans' tests are
> green and map the lifecycle changes below onto the live code. Any unrelated
> semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/007-harden-backend-url-fetching.md`
- **Category**: bug
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

`processItem` writes a complete classified item as `ready`, then performs
optional dynamic-space suggestion and steering work inside the same outer
`try`. Any later query/mutation/scheduler failure reaches the shared catch and
unconditionally calls `failItem`, downgrading a usable item to `failed`. This
plan makes core classification the sole owner of item status and moves optional
enrichment into an idempotent, bounded-retry job with stale-write guards.

## Current state

- `convex/ai.ts:528-649` fetches/classifies content and calls `finalizeItem` with
  `status: "ready"`.
- Lines 650-668 then call `setSpacesForItem`, query directly saved spaces, and
  schedule `steerItemForSpace` jobs.
- Lines 669-672 catch failures from both phases and call
  `internal.items.failItem` unconditionally.
- `convex/items.ts:480-520` `finalizeItem` patches any existing item with no
  current-status/generation guard and accepts a caller-provided status.
- `failItem` at lines 577-587 patches any existing item to `failed`, including an
  item already finalized ready by the same action.
- `setSpacesForItem` is designed to be idempotent and protects user-owned saved/
  dismissed membership rows; preserve that invariant.
- `steerItemForSpace` catches and logs errors but has no bounded retry. Its write
  path in `spaces.ts:473-486` checks that membership is still saved, but not
  whether the space name/purpose changed while the model call was in flight.
- There is no user-facing need for an enrichment status field today. Prefer
  structured logs and bounded retry over schema growth unless implementation
  reveals a concrete UI requirement.

## Required lifecycle

```text
processing item
  -> core fetch/classify fails -> fail only if still processing
  -> core finalize succeeds atomically:
       patch ready
       enqueue optional enrichment
  -> optional enrichment succeeds or retries/logs
       item remains ready in every outcome
```

Two concurrent/stale core attempts must not overwrite a ready item. Optional
writes must re-check the current item/membership/space context immediately before
mutation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `bun run test -- convex/items.test.ts convex/model/process-item.test.ts` | exits 0, lifecycle cases pass |
| Full gate | `bun run check` | exits 0 |
| Downgrade scan | `rg -n 'failItem' convex/ai.ts` | only core-failure path references it |

## Suggested executor toolkit

- Read `convex/_generated/ai/guidelines.md` before edits, especially scheduler,
  internal function, and test rules.
- Use `testing-guidelines`. Extract only the small lifecycle coordinator needed
  to inject classification/enrichment failures; do not abstract prompts or all
  of `ai.ts` for testability.

## Scope

**In scope**:
- `convex/ai.ts`
- `convex/items.ts`
- `convex/spaces.ts`
- `convex/model/process-item.ts` (create only for a small testable coordinator)
- `convex/items.test.ts` from plans 003/004
- `convex/model/process-item.test.ts` (create)
- `plans/README.md`

**Out of scope**:
- Changing classification prompts, models, tags, titles, or intents.
- Adding a user-facing enrichment status/progress UI.
- Retrying core AI classification indefinitely; existing core failure remains a
  failed item.
- Rewriting membership state semantics or recommendation ranking.
- Undoing plan 007's safe-fetch policy.

## Git workflow

- Branch: `advisor/008-isolate-ai-enrichment`
- Prefer one commit for guarded status mutations and one for optional job/retries.
- Use imperative subjects and do not push/open a PR unless instructed.

## Steps

### Step 1: Make item status transitions conditional

Refactor internal mutations in `convex/items.ts`:

- `finalizeItem` (or a clearly renamed `finalizeCoreItem`) always transitions
  `processing -> ready`; remove its caller-controlled `status` argument.
- Before patching, load the item and return a typed result such as
  `"finalized" | "stale" | "missing"`. Patch only when current status is
  `processing`.
- `failItem` also returns a typed result and patches only when current status is
  `processing`. A ready or already-failed item is a no-op.
- Keep search-text construction and all existing classified fields unchanged.

This status guard is the minimum stale/concurrent protection: the first core
attempt to leave `processing` wins, and a late attempt cannot overwrite it.

**Verify**: Convex tests cover processing→ready, processing→failed, ready→fail
no-op, failed→finalize no-op, missing, and two finalizers where exactly one wins.

### Step 2: Enqueue enrichment atomically with core finalization

Pass the classified `spaceIds` into the guarded finalize mutation. When that
mutation successfully patches ready, call `ctx.scheduler.runAfter(0, ...)` for a
new internal `enrichReadyItem` action in the same Convex mutation transaction.
If the finalizer returns stale/missing, do not enqueue enrichment.

This removes the crash gap between writing ready and scheduling optional work.
The action args should be bounded: `itemId`, deduplicated `spaceIds`, and attempt
number only. Preserve `setSpacesForItem`'s ownership checks; stale/deleted/non-
dynamic spaces are already filtered by its mutation.

**Verify**: Convex test confirms one successful finalize schedules one
enrichment job; stale finalize schedules none.

### Step 3: Separate the core catch from optional work

Refactor `processItem` so its `try/catch` covers only:

- reading current item/spaces needed by classification;
- safe page/image acquisition from plan 007;
- model generation and result sanitation;
- guarded core finalize.

On catch, log a structured core failure and call guarded `failItem`. Return
immediately. Remove `setSpacesForItem`, saved-space query, and steering schedule
from this outer action. After a successful finalize call there must be no code
path from an optional failure to `failItem`.

If extracting a test seam, create `convex/model/process-item.ts` with a small
coordinator receiving `classify`, `finalize`, and `fail` functions. Leave prompt
construction and model calls in `ai.ts`.

**Verify**: coordinator test: classification failure calls fail once; finalize
success never calls fail; stale finalize exits without optional work; downgrade
scan shows only core catch references `failItem`.

### Step 4: Implement idempotent bounded-retry enrichment

Add `enrichReadyItem({ itemId, spaceIds, attempt })` in `convex/ai.ts`:

1. re-read item; return if missing or not ready;
2. call idempotent `setSpacesForItem` with deduplicated IDs;
3. query current saved space IDs;
4. schedule `steerItemForSpace` for each current saved membership.

Catch optional failures locally. Log structured fields (`phase`, item ID,
attempt, safe error category). Retry the entire idempotent job with bounded
backoff, for example 30 seconds, 5 minutes, and 30 minutes, then log terminal
failure. Never call `failItem` and never patch core status.

Avoid an enrichment schema field unless a product consumer needs it. The
scheduler plus structured logs are sufficient for current invisible optional
work.

**Verify**: tests with injected failures prove backoff count is bounded,
success stops retries, deleted/non-ready item exits, and repeated execution does
not duplicate/overwrite user-owned membership decisions.

### Step 5: Guard steering writes against stale purpose/lifecycle

Make `steerItemForSpace` retry optional failures with the same bounded-attempt
pattern, but perform these re-checks **inside the `setMembershipIntentsInternal`
mutation transaction** (action-level pre-reads can race user edits and are only
a fast path; the mutation's existing in-transaction saved-status check is the
model), before writing:

- re-check item still exists and is ready;
- re-check the membership still exists and is effectively `saved`;
- prevent a model result generated for an old space purpose from overwriting a
  newer one. The smallest current guard is to pass the **expected space name**
  to `setMembershipIntentsInternal` and no-op if the current name differs. The
  installed steering prompt at `convex/ai.ts` uses only `space.name`, not
  `description` — pass name only, and revisit only if a future prompt adds
  description.

Keep the existing invariant that suggested/dismissed/missing rows never receive
steering intents. Do not retry forever and do not turn steering failure into
item failure.

**Verify**: tests cover membership removed/dismissed during model call, space
renamed during model call, item deleted/non-ready, retry then success, and retry
exhaustion; no stale write occurs.

### Step 6: Verify end-to-end lifecycle behavior

Using deterministic mocked model/fetch dependencies or a development deployment:

1. core classification failure → item `failed`;
2. core success + enrichment success → item `ready`, suggestions/steering appear;
3. core success + `setSpacesForItem` failure → item remains `ready`, retry queued;
4. core success + steering failure → item remains `ready`, bounded retry/log;
5. two core process attempts → first terminal status wins, no overwrite;
6. user changes/removes membership while steering runs → no stale intent write.

**Verify**: focused tests and `bun run check` exit 0; document any development
failure injection in PR notes.

## Test plan

- Guarded mutation tests for every terminal-state transition and concurrency.
- Core coordinator tests for success, classify failure, stale finalizer.
- Optional enrichment tests for success, transient failure/backoff, exhaustion,
  repeated execution, missing/non-ready item, user-owned membership protection.
- Steering stale-context tests for renamed space and removed/dismissed membership.
- Regression assertion: after any optional failure, item status is still ready.

## Done criteria

- [ ] Only core processing can transition `processing` to ready/failed.
- [ ] `failItem` cannot downgrade ready.
- [ ] A late finalizer cannot overwrite an already terminal item.
- [ ] Successful finalize atomically enqueues optional enrichment.
- [ ] Optional enrichment and steering use bounded retries and structured logs.
- [ ] Optional failures never patch core item status.
- [ ] Stale membership/space context cannot overwrite newer user state.
- [ ] Focused tests and `bun run check` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Plan 007 is incomplete or safe-fetch changes cannot be preserved.
- Convex scheduler calls cannot participate in the successful finalization
  mutation as documented by the current runtime.
- Conditional status transitions require a schema migration not described here.
- Optional work is discovered to be required for rendering/core item usability;
  reclassify that specific step as core before proceeding.
- A stale steering write cannot be guarded without adding an explicit revision;
  report the need for a revision field rather than using timestamps heuristically.
- Any verification fails twice after a focused correction.

## Maintenance notes

- Keep core and optional phases visually separated in `ai.ts`; future optional
  enrichments should run from `enrichReadyItem` or another status-independent job.
- If operations need user-visible progress later, add a dedicated enrichment
  status rather than reusing core `items.status`.
- Reviewers should search every `failItem` call and ensure it is reachable only
  before successful core finalization.
