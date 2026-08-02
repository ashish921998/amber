# Plan 004: Make incoming shares recoverable

> **Executor instructions**: Complete plan 003 first. Follow this plan step by
> step and run each verification. Preserve successful entries on partial
> failure; never restore the current unconditional clear-and-navigate behavior.
> Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- convex/schema.ts convex/items.ts src/lib/use-save-image.ts 'src/app/(app)/share.tsx' src/lib/share/storage.ts src/lib/share/process-share.ts src/lib/share/process-share.test.ts`
> Changes from completed plan 003 are expected in the first four existing files.
> Confirm its operation ledger and settled image result contract match this
> plan. Any unrelated mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/003-make-image-imports-retry-safe.md`
- **Category**: bug
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

The share target currently logs any failure, clears every native payload, and
navigates Home in `finally`. A partial save is therefore both invisible and
non-retryable, while retrying before clear can duplicate successful links or
notes. Empty payload and resolution-error states can also display “Saving…”
forever. This plan gives the flow an explicit state machine, durable session
identity, item-level idempotency, and user-controlled retry/cancel/continue
behavior.

## Current state

- `src/app/(app)/share.tsx:19-29` reads only resolved payloads, resolution state,
  error, and clear. It ignores `sharedPayloads` and `refreshSharePayloads`.
- A `handled` ref permits one attempt per mount but is not durable across
  remounts or process death.
- Lines 32-58 sequentially create links/notes, batch images, catch only at the
  outer level, then always call `clearSharedPayloads()` and `router.replace('/')`.
- The screen always renders a spinner and “Saving to Amber…”, including when
  resolution fails or no payload exists.
- SDK 57 `useIncomingShare` exposes `sharedPayloads`,
  `resolvedSharedPayloads`, `isResolving`, `error`, `refreshSharePayloads`, and
  `clearSharedPayloads`. Clearing is synchronous and removes all native payloads;
  there is no API to clear one entry.
- Plan 003 provides `itemOperations` and stable per-image operations. This plan
  must extend link/note creation to use the same generic ledger.

## Required state model

The UI must represent these states explicitly:

```text
resolving -> saving(progress) -> complete -> clear -> Home
    |              |
    |              +-> partial/failed -> retry failed | continue | cancel
    +-> resolution error -> retry resolution | cancel
    +-> empty/invalid -> explain -> done/cancel
```

“Continue” accepts already saved entries and discards failed native payloads.
“Cancel” clears the entire incoming share and leaves without creating unstarted
entries. Neither action may imply failed content was saved.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `bun run test -- src/lib/share/process-share.test.ts convex/items.test.ts` | exits 0, share/idempotency cases pass |
| Typecheck | `bun run typecheck` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Suggested executor toolkit

- Read SDK 57 Sharing docs and the installed
  `node_modules/expo-sharing/src/useIncomingShare.ts`; incoming share is marked
  experimental, so use the exact installed contract.
- Use the `testing-guidelines` skill if available. Keep orchestration tests pure
  and inject mutations/storage; do not mount Clerk/Convex providers.

## Scope

**In scope**:
- `convex/items.ts`
- `convex/items.test.ts` from plan 003
- `src/app/(app)/share.tsx`
- `src/lib/share/storage.ts` (create)
- `src/lib/share/process-share.ts` (create)
- `src/lib/share/process-share.test.ts` (create)
- `plans/README.md`

**Out of scope**:
- Changing the native share extension or `expo-sharing` package.
- Per-payload native clearing; the installed API clears the full batch only.
- Redesigning Add or Camera import UI.
- Saving unsupported audio/video/file payloads. They should be reported as
  unsupported entries, not silently coerced into notes.
- Global background uploads after the user explicitly cancels.

## Git workflow

- Branch: `advisor/004-recoverable-incoming-share`
- Prefer one backend idempotency commit and one client state-machine/tests commit.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Make shared links and notes idempotent

Add optional `operationId` arguments to `createLinkItem` and `createNoteItem`.
When present, use plan 003's `itemOperations` helper with kind `link` or `note`:

- same user+operation+kind returns the existing live item ID;
- a kind mismatch rejects;
- item insertion, optional space membership, operation completion, and scheduler
  job happen in one mutation;
- calls without an operation ID remain supported for ordinary Add UI, unless
  migrating that caller at the same time is smaller and fully tested.

Ensure `deleteItem` continues to release operation rows as established by plan
003. Do not deduplicate by URL/text content globally.

**Verify**: extend `convex/items.test.ts` for repeated shared link and note
operations, cross-user isolation, and same-content/different-operation creating
two intentional items → focused Convex tests pass.

### Step 2: Persist one incoming-share session safely

Create `src/lib/share/storage.ts` using a dedicated MMKV instance. Persist:

- a fingerprint of the current raw `sharedPayloads` including order and
  duplicates;
- a random session UUID;
- each resolved entry's stable operation ID (`share:<session>:<index>`), kind,
  and status (`pending`, `saved`, `failed`, or `unsupported`);
- completed item IDs where available;
- session phase (`active` or `complete`).

Use an ordered occurrence index so two identical entries in one batch remain
distinct. Reuse the session only when the current raw fingerprint matches.
Persist `phase: complete` before calling the native clear function. On remount:

- matching active session resumes only pending/failed entries;
- matching complete session clears native payloads without creating anything,
  then deletes the completed session record in that same reconciliation step.
  Completed state is **single-use**: a fingerprint match alone is not durable
  identity, so once a completed session has been reconciled against (used to
  clear payloads), it must not linger — otherwise a deliberate later re-share
  of identical content would match it and be silently dropped instead of
  starting a fresh session;
- empty native payloads remove stale local session state;
- a different fingerprint starts a new UUID/session.

This ordering closes both crash windows: after backend success but before local
clear, and after local clear but before local session deletion.

**Verify**: storage tests with an in-memory adapter prove all four remount cases.
Keep serialization/versioning in one module so a future shape change can discard
incompatible stale state safely.

### Step 3: Extract an item-level share processor

Create `src/lib/share/process-share.ts` as a pure coordinator with injected
functions for link, note, and image saves. It must:

- convert resolved payloads into entries without starting side effects;
- treat image without `contentUri`, blank text, malformed website URL, and
  unsupported content types as explicit failed/unsupported results;
- process each entry independently and retain every success;
- call plan 003's image save with the entry's stable operation ID;
- call link/note mutations with their stable operation IDs;
- accept prior results and retry only `failed` entries;
- emit progress after each settled entry for the UI/persistence layer;
- prevent two concurrent runs for the same session in the screen adapter.

Do not use one outer catch/finally that erases entry-level outcomes.

**Verify**: pure processor tests cover all success, one-of-three failure,
retry-only-failed, duplicate effect invocation, malformed/unsupported input, and
an ambiguous response followed by idempotent retry.

### Step 4: Render the explicit share state machine

Replace the spinner-only `share.tsx` UI:

- resolution in progress: spinner and resolving copy;
- resolution error: error copy, `Try again` calling `refreshSharePayloads`, and
  `Cancel` clearing and returning Home;
- no raw payload after resolution: “Nothing to save” with a Done action;
- saving: progress `Saved N of M` and disable duplicate starts;
- partial/failed: list or concise count of successes/failures with `Retry failed`,
  `Continue with saved`, and `Cancel`;
- complete: mark persistent session complete, clear native payloads, delete local
  session after clear, and replace Home exactly once.

On `Continue with saved`, persist complete before clearing; explain that failed
entries will be discarded. On `Cancel`, do not claim success. Navigation and
clear must be centralized in one idempotent completion function.

Use existing theme typography/buttons rather than adding a design system.

**Verify**: `bun run check` → exit 0; no unconditional clear remains in a
`finally` block (`rg -n 'finally' 'src/app/(app)/share.tsx'` should return no
match unless a non-clearing cleanup use is justified in review).

### Step 5: Exercise native share workflows

On both iOS and Android development builds, test:

1. one URL, one note, one image;
2. a batch of images;
3. forced one-entry backend failure followed by retry;
4. continue after partial failure;
5. resolution error then refresh;
6. empty/unsupported payload;
7. background/foreground and screen remount during save;
8. process termination after one backend success, then relaunch.

For cases 3, 7, and 8, verify item counts in Amber: each successful entry exists
exactly once and failed entries remain retryable until explicit continue/cancel.

**Verify**: record platform/case outcomes in PR notes; any duplicate or cleared
unacknowledged failure is a failed verification.

## Test plan

- Backend tests: link/note idempotency, operation kind mismatch, cross-user
  isolation, intentional same-content saves under distinct operations.
- Processor tests: all success, partial failure, retry, malformed, unsupported,
  duplicate invocation, result ordering.
- Storage/session tests: active resume, complete-before-clear resume,
  clear-before-local-delete cleanup, new fingerprint, duplicate payload entries.
- Manual iOS/Android matrix from step 5.
- Verification: focused tests and `bun run check` pass.

## Done criteria

- [ ] Every share entry has a stable operation ID across retries/remounts.
- [ ] Link, note, and image entries are idempotent per user+operation.
- [ ] Partial failures remain visible and retryable; successes are not retried.
- [ ] Native payloads clear only on all-success or explicit continue/cancel.
- [ ] Empty, unsupported, and resolution-error states never spin forever.
- [ ] Remount/process-restart tests create no duplicates.
- [ ] Focused tests and `bun run check` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Plan 003's operation ledger/result contract is absent or materially different.
- The installed Sharing API cannot provide stable raw payloads long enough to
  fingerprint/reconcile the session.
- MMKV is unavailable in the share-target app context.
- A design requires silently discarding failed entries or globally deduplicating
  identical user content.
- Native clear semantics differ from “clear all current payloads.”
- Any verification fails twice after a focused fix.

## Maintenance notes

- Version the persisted session shape. On incompatible future versions, show a
  recoverable error and ask before clearing rather than guessing.
- Keep operation idempotency server-side even if the UI guard appears reliable;
  effects, remounts, and network ambiguity make client-only guards insufficient.
- Reviewers should scrutinize the ordering: persist complete → native clear →
  local session delete → navigate.
