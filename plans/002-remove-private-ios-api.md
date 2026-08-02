# Plan 002: Remove the private iOS blur API

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If a STOP condition occurs, stop and report — do not improvise.
> Update this plan's row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- modules/progressive-blur/index.tsx modules/progressive-blur/ios/ProgressiveBlurModule.swift modules/progressive-blur/ios/ProgressiveBlurView.swift`
> Drift caused only by completed plan 001 is irrelevant because it does not
> touch these paths. Any change in these paths is a STOP condition until it is
> reconciled with this plan.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-establish-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

The custom progressive-blur module reflectively constructs Apple's private
`CAFilter`/`variableBlur` API and deliberately base64-obfuscates the class and
selector names. This creates a concrete App Review rejection risk under Apple
Guideline 2.5.1. The replacement must use public UIKit/Core Animation APIs and
accept a close visual approximation rather than pretending public iOS APIs can
provide spatially varying live blur radius.

## Current state

- `modules/progressive-blur/ios/ProgressiveBlurView.swift:8-13` documents use
  and obfuscation of the private API.
- Lines 176-204 decode `CAFilter` and `filterWithType:`, call
  `NSClassFromString`/`NSSelectorFromString`/`perform`, construct
  `variableBlur`, and set undocumented KVC keys.
- The same view already owns a public `UIVisualEffectView` and a public
  `CAGradientLayer` opacity mask. Those are sufficient for a fixed blur whose
  opacity feathers to transparent at the header edge.
- `modules/progressive-blur/index.tsx` exposes an `intensity` prop, but all four
  consumers call `<ProgressiveBlurHeader />` with no prop:
  home, search, spaces, and `space/[id]`.
- There is no public UIKit API that maps the numeric `intensity` to a true blur
  radius. Do not use `UIViewPropertyAnimator` as a permanently paused private-
  effect substitute and do not add another third-party variable-blur package.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full JS gate | `bun run check` | exit 0 |
| Private source scan | `rg -n -e 'CAFilter' -e 'variableBlur' -e 'NSClassFromString' -e 'NSSelectorFromString' -e 'filterWithType' -e 'inputMaskImage' -e 'base64Decode' modules/progressive-blur` | exit 1, no matches |
| Native build | `xcodebuild -workspace ios/amber.xcworkspace -scheme amber -configuration Release -sdk iphonesimulator -derivedDataPath /tmp/amber-private-api-check CODE_SIGNING_ALLOWED=NO build` | exit 0, `** BUILD SUCCEEDED **` |

## Suggested executor toolkit

- Read the versioned Expo Modules native-view guide:
  `https://docs.expo.dev/versions/v57.0.0/modules/native-view-tutorial/`.
- Read Apple App Review Guideline 2.5.1 before reviewing the final diff.
- Use the iOS simulator/device workflow available in the environment for the
  visual checks; this cannot be verified by TypeScript alone.

## Scope

**In scope**:
- `modules/progressive-blur/index.tsx`
- `modules/progressive-blur/ios/ProgressiveBlurModule.swift`
- `modules/progressive-blur/ios/ProgressiveBlurView.swift`
- `plans/README.md`

**Out of scope**:
- Replacing native navigation headers or changing the four screen layouts.
- Recreating true variable-radius blur through undocumented APIs, runtime
  reflection, Core Image filters on private backdrop content, or a dependency.
- Android behavior; the component currently and correctly no-ops there.
- Renaming the module or component; keeping the public component name minimizes
  churn even though the implementation becomes an opacity-feathered blur.

## Git workflow

- Branch: `advisor/002-public-progressive-blur`
- Use one imperative commit such as `Replace private blur filter with public UIKit APIs`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Reduce the native view to public APIs

In `ProgressiveBlurView.swift`:

- Keep `UIVisualEffectView(effect: UIBlurEffect(style: .regular))`, the
  non-interactive behavior, the gradient `layer.mask`, edge overhang, and
  layout-driven mask updates.
- Remove `maxBlurRadius`, `appliedSize`, `appliedRadius`,
  `applyVariableBlur`, `makeGradientMask`, `makeVariableBlurFilter`, and
  `base64Decode` in full.
- Do not reach into `blurView.subviews` or assign `backdropLayer.filters`.
- Update comments to describe the honest behavior: a standard public blur is
  fully visible at the top and its view opacity feathers to zero near the
  header's lower edge. Avoid claims about varying radius.
- Preserve `CATransaction.setDisableActions(true)` so rotations/resizes do not
  animate the mask unexpectedly.

**Verify**: run the private source scan in the command table → no matches and
exit 1; `swiftc` is not sufficient because this view depends on Expo, so proceed
to the workspace build in step 3.

### Step 2: Remove the unsupported intensity contract

- Remove the `intensity` prop and its registration from
  `ProgressiveBlurModule.swift`.
- Remove `NativeProps.intensity`, the component parameter/default, and the prop
  passed to `NativeBlur` in `index.tsx`.
- Keep view props and absolute header sizing unchanged. All current consumers
  must compile without edits because none passes `intensity`.

**Verify**: `rg -n 'intensity|maxBlurRadius' modules/progressive-blur` → no
matches; `bun run check` → exit 0.

### Step 3: Build and scan the release simulator product

Run the exact `xcodebuild` command from the command table. Then scan both source
and the built app/module artifacts:

```bash
APP=$(find /tmp/amber-private-api-check/Build/Products/Release-iphonesimulator -maxdepth 1 -name '*.app' -print -quit)
test -n "$APP"
BINARY="$APP/amber"
test -f "$BINARY" && test -r "$BINARY"

SCAN_OUTPUT=$(mktemp)
if strings "$BINARY" > "$SCAN_OUTPUT"; then
  strings_status=0
else
  strings_status=$?
fi
if rg \
  -e 'CAFilter' \
  -e 'variableBlur' \
  -e 'NSClassFromString' \
  -e 'NSSelectorFromString' \
  -e 'filterWithType' \
  -e 'inputMaskImage' \
  -e 'base64Decode' \
  "$SCAN_OUTPUT"; then
  rg_status=0
else
  rg_status=$?
fi
rm -f "$SCAN_OUTPUT"
test "$strings_status" -eq 0 && test "$rg_status" -eq 1
```

`strings` must exit 0 and `rg` must exit 1 with no output. The `test -f && test -r`
guard and the `strings_status` check are load-bearing: without them a `strings`
failure (missing/unreadable binary, wrong path) yields empty output, `rg` exits 1
on the empty input, and the pipeline falsely reports a clean pass. If another dependency
contains one of these strings, do not hide the result. This app is a prebuilt
bare-workflow build where every pod is statically linked into the single
`$APP/amber` binary, so "identify its binary and STOP" is not always
actionable. If every match can be proven (by `rg` over `node_modules/<pkg>` and
the Pods) to originate from a dependency **other than** `modules/progressive-blur`
(e.g. a Skia/runtime-effect blur), record that package on a documented allowlist
in the commit/PR notes and continue; if any match traces back to the blur
module, STOP rather than hiding the result.

**Verify**: native build exits 0 and both private-API scans have no matches.

### Step 4: Verify the approximation on real UI states

On an iOS simulator and, before release, one physical device:

1. Open Home, Search, Spaces, and a single Space.
2. Scroll high-contrast cards/text beneath the transparent header.
3. Confirm the top area is blurred, the lower edge fades without a hard line,
   and header buttons remain tappable.
4. Rotate or resize on a simulator and switch light/dark appearance; confirm the
   mask updates and no stale frame remains.
5. Confirm Android still renders no native blur view and does not throw a module
   resolution error.

Capture one before/after screenshot per distinct header layout for PR review.

**Verify**: record the four-screen simulator results and physical-device result
in the commit/PR notes. Any crash, touch interception, or visible hard edge is a
failed verification.

## Test plan

- There is no useful unit test for this rendering-only native change.
- Automated gates are the source/binary scans, JS check, and Release simulator
  build.
- Manual regression matrix: four consumers × scrolled/unscrolled; light/dark;
  at least one physical iOS device; Android no-op smoke check.

## Done criteria

- [ ] No private class, selector, filter type, or KVC key remains in the module.
- [ ] The module uses only documented UIKit/Core Animation APIs.
- [ ] The unsupported intensity prop is gone and all consumers compile unchanged.
- [ ] `bun run check` exits 0.
- [ ] Release simulator workspace build succeeds.
- [ ] Source and built-binary scans return no private blur symbols.
- [ ] Manual visual/touch checks pass and are documented.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Product/design requires true spatially varying blur radius rather than the
  public fixed-blur/opacity-fade approximation.
- A private API, selector obfuscation, undocumented KVC key, or subview/backdrop
  traversal appears necessary to match the old visual exactly.
- The Release build or binary scan fails twice after a focused correction.
- Any current consumer has begun relying on a non-default `intensity` prop.
- A change outside the in-scope module is required.

## Maintenance notes

- Reviewers should prioritize App Review safety over pixel-identical blur.
- Future visual tuning should change only public blur style and gradient stops.
- Re-run the binary scan when adding native visual-effect dependencies.
