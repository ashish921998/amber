# Plan 001: Establish one reliable verification command

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's status row in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- package.json bun.lock eslint.config.js 'src/app/(app)/manage-spaces.tsx' 'src/app/(app)/new-space.tsx' 'src/app/(app)/item/[id].tsx' src/lib/url.ts vitest.config.ts convex/model/memberships.test.ts src/lib/url.test.ts .github/workflows/ci.yml`
> If any existing in-scope file changed, compare the live code with the
> "Current state" section. On a material mismatch, STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

The repository currently has no test script or CI workflow, and `bun run lint`
fails. That makes every reliability fix in the remaining plans harder to review
and easier to regress. This plan creates a deterministic local/CI gate without
requiring live Clerk, Convex, or AI credentials.

## Current state

- `package.json` has only start/platform/web/lint scripts. It declares
  `"packageManager": "yarn@1.22.22"` despite the committed `bun.lock` and Bun
  commands in the README.
- `bunx tsc --noEmit` exits 0 at the planned commit. The prior Clerk ticket type
  mismatch has already been fixed; do not rework Clerk auth in this plan.
- `bun run lint` reports exactly 2 errors and 3 warnings:
  - `src/app/(app)/manage-spaces.tsx:27-31` mirrors query data by synchronously
    calling `setMembers` in an effect.
  - `src/app/(app)/new-space.tsx:42-48` pre-fills three state values by
    synchronously calling setters in an effect.
  - `src/app/(app)/item/[id].tsx:70-97` creates `list` outside the memo that
    consumes it; line 104 declares unused `editing` state.
- No `*.test.*`, `*.spec.*`, or `.github/workflows/*` files exist.
- Convex requires `convex/_generated/ai/guidelines.md` to be read before editing
  Convex files. Its test guidance uses `convex-test`, Vitest, and
  `@edge-runtime/vm`, with `import.meta.glob("./**/*.ts")` as the module map.
- `src/lib/url.ts` and `convex/model/memberships.ts` are small pure modules that
  can provide credential-free smoke tests. `effectiveStatus` must continue to
  interpret legacy status-less memberships as `"saved"`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install --frozen-lockfile` | exit 0 before dependency changes |
| Current typecheck | `bunx tsc --noEmit` | exit 0, no output |
| Current lint | `bun run lint` | exit 1 with 2 errors and 3 warnings before fixes |
| Final gate | `bun run check` | exit 0; lint, typecheck, and all tests pass |

## Suggested executor toolkit

- Read `https://docs.expo.dev/versions/v57.0.0/develop/unit-testing/` before
  configuring tests; this repo uses Expo SDK 57.0.2. Note: that doc recommends
  `jest-expo`, which does **not** apply here — these tests never load the React
  Native runtime and this plan forbids adding Jest. Use Vitest only.
- Read `convex/_generated/ai/guidelines.md` before creating the Convex test.
- If available, use the `testing-guidelines` skill for test naming and fixture
  design and the `no-use-effect` skill for the two lint fixes.

## Scope

**In scope** (the only files you should modify):
- `package.json`
- `bun.lock`
- `eslint.config.js` only if Vitest globals need a scoped lint override
- `src/app/(app)/manage-spaces.tsx`
- `src/app/(app)/new-space.tsx`
- `src/app/(app)/item/[id].tsx`
- `vitest.config.ts` (create)
- `convex/model/memberships.test.ts` (create)
- `src/lib/url.test.ts` (create)
- `.github/workflows/ci.yml` (create)
- `plans/README.md`

**Out of scope**:
- Auth behavior, Clerk configuration, or dev-ticket login.
- Product behavior beyond removing the five current lint findings.
- Snapshot, device, or end-to-end test infrastructure; downstream plans add
  focused lifecycle tests on top of this unit/Convex foundation.
- Generated files under `convex/_generated/`.

## Git workflow

- Branch: `advisor/001-verification-baseline`
- The repo uses imperative commit subjects (for example,
  `Fix dev login to use Clerk v3 ticket strategy`). Use one commit for the
  lint fixes and one for tooling/CI if practical.
- Do not push or open a PR unless the operator instructs it.

## Steps

### Step 1: Add explicit Bun scripts and test dependencies

In `package.json`:

- Set `packageManager` to `bun@1.3.12`, matching the planned environment and
  committed Bun lockfile.
- Add `typecheck: "tsc --noEmit"`, `test: "vitest run"`, and
  `check: "bun run lint && bun run typecheck && bun run test"`.
- Add compatible dev dependencies for `vitest`, `convex-test`, and
  `@edge-runtime/vm` using Bun. Do not add Jest or a second test runner.

Create `vitest.config.ts` with **Node as the default environment** and test
include patterns for both `src/**/*.test.ts` and `convex/**/*.test.ts`. Keep
setup minimal; do not load the app root, native modules, or environment secrets.

> **Deliberate deviation from the Convex guideline.**
> `convex/_generated/ai/guidelines.md` (line 316) says to set
> `environment: "edge-runtime"` globally. **Do not do that here.** A global
> edge-runtime environment makes it impossible to load any test file that
> imports a Node-only module: plan 007's `convex/model/safe-fetch.ts` imports
> `undici`, which needs `node:net`/`node:tls` and cannot be required under
> `@edge-runtime/vm`. Use Node as the default and apply the edge-runtime
> environment **only to `convex-test`-based files**, via a per-file
> `// @vitest-environment edge-runtime` pragma at the top of those files (or
> `environmentMatchGlobs` in `vitest.config.ts` — but if you use globs you
> must explicitly exempt `convex/model/safe-fetch.test.ts` back to Node).
> Plain TS tests such as `src/lib/url.test.ts` and the safe-fetch tests run in
> the Node default. This keeps the guideline's intent (Convex-runtime fidelity
> for Convex-function tests) without breaking Node-runtime tests.

**Verify**: `bun install && bun run typecheck` → both commands exit 0 and
`bun.lock` is updated.

### Step 2: Remove all existing lint findings without suppressions

- In `manage-spaces.tsx`, replace effect-based initialization with derived
  server state plus an optional optimistic override. The render should use the
  override when present and otherwise derive a `Set` from `item.spaces`; the
  toggle callback must clone whichever set is currently rendered. Do not add an
  eslint disable and preserve immediate switch feedback.
- In `new-space.tsx`, remove the prefill effect. Use a loading/edit wrapper and
  a keyed form component whose `useState` initializers receive the loaded space
  values. The create form must still initialize `dynamic` to true; the edit form
  must initialize it from `space.dynamic ?? false`; user typing must never be
  overwritten by a query refresh.
- In `item/[id].tsx`, memoize construction of `list` from the three query
  results before the `items` memo, and remove unused `editing` state. Preserve
  feed ordering and swipe behavior.

**Verify**: `bun run lint` → exit 0 with no errors or warnings.

### Step 3: Add credential-free smoke and characterization tests

- `src/lib/url.test.ts`: cover URL recognition with and without `https://`,
  whitespace rejection, and `displayHost` fallback for malformed input.
- `convex/model/memberships.test.ts`: use minimal typed fixtures or
  `convex-test` as appropriate to assert explicit `suggested`, `saved`, and
  `dismissed` statuses plus the legacy absent-status → `saved` rule. Do not use
  `as any`; construct only the required test fixture through a typed helper.
- Include at least one `convex-test` smoke case that loads the schema/module map
  and performs a database operation without live Convex credentials. If the
  membership test remains purely functional, put this smoke case in the same
  file and state clearly what it verifies. Any file that calls `convex-test`
  must start with `// @vitest-environment edge-runtime` (see the Step 1
  deviation note); pure-TS test files do not.

**Verify**: `bun run test` → exit 0, all new tests pass, and no network request
or environment secret is required.

### Step 4: Add the CI gate

Create `.github/workflows/ci.yml` for pushes and pull requests. It must:

1. check out the repository;
2. install Bun 1.3.12;
3. run `bun install --frozen-lockfile`;
4. run only `bun run check`.

Do not add production secrets. The tests must be designed so CI is green on a
fork with no `.env.local`.

**Verify**: parse the workflow with
`bun -e "console.log(require('fs').readFileSync('.github/workflows/ci.yml','utf8').includes('bun run check'))"`
→ prints `true`; then `bun run check` → exit 0.

## Test plan

- Add the two test files listed above.
- Required cases: URL happy/malformed paths; all explicit membership states;
  legacy membership fallback; Convex schema/module smoke load.
- Verification: `bun run test` → all tests pass; `bun run check` → the complete
  local gate passes.

## Done criteria

- [ ] `bun run lint` exits 0 with zero warnings.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run test` exits 0 without network or secrets.
- [ ] `bun run check` runs all three in that order and exits 0.
- [ ] CI uses Bun and `bun install --frozen-lockfile`.
- [ ] `packageManager` and the committed lockfile both describe Bun.
- [ ] No eslint disable was added for the three existing source findings.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report (do not improvise) if:

- `bunx tsc --noEmit` is not green before changes; the baseline has drifted.
- Fixing a lint finding requires changing user-visible behavior or a file not in
  scope.
- The selected Vitest/Convex versions cannot run under Bun 1.3.12 and Expo 57
  after one focused compatibility adjustment.
- Tests attempt to contact a live Convex deployment or require Clerk/AI keys.
- Any verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- Every later plan should add focused regression tests and rely on
  `bun run check` as its final gate.
- Keep the aggregate command boring. Do not add device builds to `check`; native
  build/visual verification belongs in plan 002 and release workflows.
- Reviewers should ensure the form refactor does not reset edits when cached
  query data refreshes.
