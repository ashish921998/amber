# Plan 007: Enforce a safe backend URL-fetch policy

> **Executor instructions**: Follow this plan in order. The feasibility gate in
> step 1 is mandatory: if the Convex Node runtime cannot bind DNS validation to
> the connection actually used, stop and report rather than claiming SSRF
> protection. Run every verification and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 325f1ee..HEAD -- package.json bun.lock convex/items.ts convex/ai.ts convex/model/external-url.ts convex/model/safe-fetch.ts convex/model/external-url.test.ts convex/model/safe-fetch.test.ts`
> Package drift from plans 001/003 is expected. Rebase on completed prerequisites
> and compare all backend files with "Current state". Material unexpected drift
> is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-establish-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `325f1ee`, 2026-08-02

## Why this matters

User-supplied links are fetched by a privileged backend action with automatic
redirects and fully buffered bodies. The current path does not restrict schemes,
credentials, private/reserved network destinations, redirect targets, content
types, or response size. This creates SSRF and resource-exhaustion risk. The fix
must validate the destination used for every actual connection, not merely parse
the first URL before allowing a separate DNS lookup.

## Current state

- `convex/items.ts:128-134` returns any string with a scheme-like `://` unchanged
  and otherwise prepends `https://`. `createLinkItem` stores and schedules it.
- `convex/ai.ts:349-365` calls `fetch(url, { redirect: "follow", timeout })` and
  then `response.text()` with no byte or content-type limit.
- `convex/ai.ts:372-399` resolves page-provided Open Graph image URLs and fetches
  them with `fetchImageAspectRatio`.
- `fetchImageAspectRatio` requests a 128 KiB range but still calls
  `response.arrayBuffer()` without enforcing that the server honored the range
  or a hard streamed limit.
- `convex/ai.ts:940-947` fetches fixed-host SerpAPI JSON and buffers it without a
  size/content-type bound. The destination is not user-controlled, but the same
  timeout/bounded-read discipline should apply without logging its API key.
- `convex/ai.ts` already declares `"use node"`, so Node DNS/HTTP libraries are
  available only if supported by the deployed Convex Node runtime.
- URL-derived page/image fetches must reject loopback, private, link-local,
  multicast, unspecified, documentation/test, reserved, and IPv4-mapped IPv6
  addresses. Validation must cover literal IPs and DNS answers.

## Security invariants

For every page or metadata-image request:

1. scheme is exactly `http:` or `https:`;
2. URL has no username/password;
3. the connection's DNS lookup returns only globally routable addresses;
4. every redirect is parsed and revalidated before the next request;
5. redirect count, time, content type, declared length, and streamed bytes are
   bounded;
6. errors/logs do not expose credentials, query secrets, response bodies, or
   internal address details.

DNS validation followed by an unrelated default `fetch` lookup is vulnerable to
DNS rebinding and is not acceptable as the final implementation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Read Convex rules | `cat convex/_generated/ai/guidelines.md` | exit 0; read first |
| Focused tests | `bun run test -- convex/model/external-url.test.ts convex/model/safe-fetch.test.ts` | exit 0, all policy tests pass |
| Full gate | `bun run check` | exit 0 |
| Unsafe pattern scan | run the command below the table | no unbounded user/fixed external fetch consumption remains |

The unsafe-pattern scan lives outside the table on purpose. Its regex uses `|`
alternation, and a Markdown table cell forces a lose-lose: an unescaped `|`
splits the row, while an escaped `\|` is copied *literally* by an executor and
then read by `rg` as a literal pipe — so the scan matches nothing and silently
"passes" while unsafe fetches remain. A fenced block needs no escaping, so it
renders and copies verbatim:

```sh
rg -n 'redirect: "follow"|response\.(text|arrayBuffer|json)\(' convex/ai.ts
```

## Suggested executor toolkit

- Read Convex Node action/runtime docs current at implementation time and the
  repo's generated Convex guidelines before selecting a transport.
- Use Node's DNS APIs plus a transport whose connection `lookup` callback can be
  controlled (for example a directly installed, Convex-compatible `undici`
  `Agent`). Use a maintained IP parser such as direct dependency `ipaddr.js`;
  do not hand-roll IPv6/reserved-range parsing.
- Use the `security-review` skill if available after implementation.

## Scope

**In scope**:
- `package.json`
- `bun.lock`
- `convex/items.ts`
- `convex/ai.ts`
- `convex/model/external-url.ts` (create)
- `convex/model/safe-fetch.ts` (create)
- `convex/model/external-url.test.ts` (create)
- `convex/model/safe-fetch.test.ts` (create)
- `plans/README.md`

**Out of scope**:
- Client-side link opening policy or link previews rendered solely on-device.
- Building an HTTP proxy service outside Convex.
- Fetching arbitrary product result URLs; SerpAPI result links are stored/opened,
  not backend-fetched here.
- Changing AI prompts/classification behavior except handling categorized fetch
  failures.
- Claiming private-network protection if the runtime feasibility gate fails.

## Git workflow

- Branch: `advisor/007-safe-backend-fetch`
- Commit the URL policy/tests separately from call-site migration if practical.
- Use imperative subjects and do not push/open a PR unless instructed.

## Steps

### Step 1: Prove connection-bound DNS validation is supported

Create a minimal local spike (delete it before committing) that bundles under
the Convex Node action environment and uses a directly declared transport
dependency with a custom connection `lookup` callback. The callback must:

- resolve all addresses for the hostname with `verbatim: true`;
- validate every answer before selecting one;
- return the validated address to the same transport connection, preserving the
  original hostname for Host header and TLS SNI.

Confirm the package is supported by Convex bundling/deployment and does not fall
back to global `fetch`. A locally passing Node test alone is insufficient if
Convex rejects the bundle. Add only the direct dependencies actually selected
(expected: `undici` and `ipaddr.js`) and pin them through `bun.lock`.

**Verify**: run Convex code generation/dev bundle validation available in the
environment and the focused test transport. Expected: custom lookup is invoked
for the connection and an injected private answer prevents the request.

If this cannot be proven, STOP and report the runtime limitation and recommend a
controlled egress proxy. Do not continue with parse-only/DNS-preflight security.

### Step 2: Centralize syntactic URL normalization

Create `convex/model/external-url.ts`, with no Node-only imports so both Convex
mutations and Node actions can use it. It should:

- trim input and prepend `https://` only when no scheme is present;
- parse with `new URL`;
- accept only `http:` and `https:`;
- reject username/password, empty hostname, invalid/non-default port forms, and
  overlong URLs;
- normalize to the URL serializer's canonical string;
- return a typed policy error category, not internal parser text.

Use it in `createLinkItem` before inserting. Remove the current regex-based
`normalizeUrl`; the special `url === "https://"` check should no longer exist.

**Verify**: URL tests cover bare domain, HTTP/HTTPS, file/gopher/data/javascript,
credentials, empty host, fragments/query, decimal/hex/short IPv4 canonicalization,
IPv6 literals, and overlong input.

### Step 3: Build the connection-bound safe fetcher

Create `convex/model/safe-fetch.ts` for Node actions. Design it around injected
resolver/transport/clock for deterministic tests. It must:

- classify literal and resolved addresses with `ipaddr.js`, including
  IPv4-mapped IPv6; allow only globally routable unicast ranges;
- reject if any DNS answer is unsafe, rather than selecting a convenient public
  answer from a mixed set;
- use the validated lookup callback on the actual connection;
- set redirect mode to manual and follow at most 3 redirects;
- resolve relative `Location` against the current URL, then re-run URL and DNS
  policy for every hop;
- apply one total deadline with `AbortController`, not a fresh unlimited budget
  per redirect;
- provide bounded streaming readers that check `Content-Length` when present and
  still stop after actual bytes exceed the limit;
- cancel the reader/response on limit breach;
- return policy error codes such as `invalid_url`, `blocked_destination`,
  `redirect_limit`, `timeout`, `unsupported_content_type`, `response_too_large`,
  and `http_error`.

Do not log raw URLs with credentials/query strings. The parser rejects embedded
credentials, but SerpAPI carries its key in the query and must be redacted.

Run `safe-fetch.test.ts` in the **Node** vitest environment (no
`// @vitest-environment edge-runtime` pragma): `safe-fetch.ts` imports `undici`,
which requires `node:net`/`node:tls` and will not load under `@edge-runtime/vm`.
This is the Node-environment exception established by plan 001 Step 1.

**Verify**: safe-fetch tests inject DNS and responses for loopback, RFC1918,
link-local, multicast, unspecified, reserved/documentation ranges, mapped IPv6,
mixed DNS answers, public success, private redirect, redirect loop, timeout,
lying/missing content length, and oversized stream. No test uses live internet.

### Step 4: Migrate page and metadata-image fetching

Replace direct page/image `fetch` calls in `convex/ai.ts`:

- Page: allow HTML/XHTML content types, total deadline 15 seconds, max 3
  redirects, and a hard 1 MiB streamed body limit. Decode text using a supported
  charset policy; reject unsupported binary content rather than feeding it to
  Readability.
- Hero image header: allow `image/*`, deadline 10 seconds, request the existing
  byte range, but enforce a hard 128 KiB streamed limit even if the server
  ignores Range. `readImageSize` receives only bounded bytes.
- Use the fetcher's final validated URL when resolving relative OG images and
  deriving site name.
- A blocked/missing hero image remains best-effort and returns no aspect ratio;
  a blocked primary page fetch is a core processing failure with a sanitized log
  category.

Remove `redirect: "follow"` and all unbounded page/image body methods.

**Verify**: focused tests plus `bun run typecheck` pass; unsafe pattern scan shows
no old page/image use.

### Step 5: Bound the fixed SerpAPI response

Route the fixed `https://serpapi.com/...` request through a bounded JSON path:

- preserve 20-second timeout;
- require JSON-compatible content type;
- cap streamed response at 1 MiB before `JSON.parse`;
- never include the request URL/API key in thrown or logged errors;
- apply the same public-address/redirect policy unless the chosen safe fetcher
  has a narrower explicit fixed-host mode with equivalent guarantees.

This call is not user-destination SSRF, but it should not remain the only
unbounded external response.

**Verify**: add tests for oversized/non-JSON SerpAPI fakes and confirm logs/error
objects contain no fake API key.

### Step 6: Run security and behavior verification

- Run focused and full tests.
- In a development Convex deployment, save a normal public article and confirm
  metadata/classification still completes.
- Attempt literal loopback/private IPv4, short/decimal IPv4, IPv6 loopback,
  credentials, non-HTTP scheme, and a public URL redirecting to private. Each
  must be rejected before an unsafe connection and produce no internal response
  data.
- Save a page with an oversized body and one with an oversized OG image; both
  must stay within bounds, with hero-image failure remaining best-effort.

**Verify**: `bun run check` exits 0 and record the development policy results in
PR notes without probing real internal services.

## Test plan

- Syntactic parser matrix from step 2.
- DNS/IP matrix: all private/reserved classes, mapped IPv6, mixed answers, public.
- Redirects: public chain, relative location, private hop, loop, over limit.
- Resources: timeout, declared oversize, streamed oversize, missing length,
  allowed/rejected content types.
- Call sites: public page success, blocked hero as best-effort, blocked page as
  core failure, bounded/redacted SerpAPI error.
- All network tests use injected resolver/transport; no live endpoints.

## Done criteria

- [ ] Stored link URLs allow only credential-free HTTP(S).
- [ ] DNS safety is bound to the actual connection, not a preflight-only lookup.
- [ ] Every redirect hop is manually revalidated and count-bounded.
- [ ] Page, image, and SerpAPI reads enforce deadlines, content types, and actual
  streamed byte limits.
- [ ] Private/reserved literal and DNS destinations are covered by tests.
- [ ] Errors/logs do not expose secrets or internal response details.
- [ ] Normal public article processing still works.
- [ ] Focused tests and `bun run check` pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- Convex cannot bundle/use a transport with connection-bound custom DNS lookup.
- The implementation can validate one DNS answer but the actual request may
  resolve independently.
- Supporting HTTPS would require disabling certificate or hostname validation.
- A dependency cannot correctly classify IPv4-mapped IPv6 and reserved ranges.
- Existing product requirements require non-HTTP schemes or credentialed URLs.
- Tests need access to real private/internal hosts.
- Any verification fails twice after a focused correction.

## Maintenance notes

- New backend fetches must use this policy; add a lint/review checklist item if
  direct `fetch` calls reappear.
- IP range data and transport behavior should be reviewed on dependency/runtime
  upgrades.
- Reviewers should verify the API key is never interpolated into an error log and
  that each redirect creates a newly policy-checked request.
