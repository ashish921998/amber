/**
 * Connection-bound safe HTTP fetcher for Convex Node actions.
 *
 * Defends against SSRF and resource exhaustion on every backend fetch of an
 * external URL. The guarantees (see plan 007) are:
 *
 *   1. scheme/credential/port/length policy from externalUrl.ts, re-run on
 *      every redirect target;
 *   2. DNS answers resolved and classified with ipaddr.js — only globally
 *      routable unicast addresses are allowed — and the validated address is
 *      the one handed to the actual socket via undici's connect.lookup, so
 *      validation cannot be bypassed by a second, independent resolution
 *      (DNS rebinding);
 *   3. manual redirects, at most MAX_REDIRECTS hops, each target revalidated
 *      before the next request, each redirect body cancelled;
 *   4. a single total deadline (AbortController) covering DNS and every hop —
 *      a resolver that never completes still times out;
 *   5. bounded streaming readers that honor Content-Length when present and
 *      still stop after actual bytes exceed the limit, cancelling the body;
 *   6. a narrow result type exposing only bounded bytes, the final validated
 *      URL, status, and sanitized metadata — never the underlying Response
 *      whose text()/json()/arrayBuffer() would bypass the limits;
 *   7. errors/logs carry only a policy code and identifiers — never
 *      credentials, query strings, redirect locations, response bodies, or
 *      resolved addresses.
 *
 * This file imports undici (node:net/node:tls), so its tests MUST run under the
 * vitest Node environment — NOT @vitest-environment edge-runtime.
 */
"use node";

import { Agent, type Dispatcher } from "undici";
import type BodyReadable from "undici/types/readable";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { normalizeExternalUrl, isUrlPolicyError, type UrlPolicyError } from "./externalUrl";

// ---------------------------------------------------------------------------
// Policy error type
// ---------------------------------------------------------------------------

export type SafeFetchError =
  | UrlPolicyError
  | "blocked_destination"
  | "redirect_limit"
  | "timeout"
  | "unsupported_content_type"
  | "response_too_large"
  | "http_error"
  | "fetch_failed";

export class SafeFetchErrorClass extends Error {
  constructor(
    public readonly code: SafeFetchError,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export function isSafeFetchError(e: unknown): e is SafeFetchErrorClass {
  return e instanceof SafeFetchErrorClass;
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/**
 * ipaddr.js `range()` returns the broad class of an address. We allow only
 * `unicast` — globally routable addresses — and reject everything else:
 * loopback, private (RFC1918), linkLocal, multicast, reserved, and
 * documentation/test ranges. IPv4-mapped IPv6 addresses are parsed by
 * ipaddr.js and their mapped IPv4 is classified, so ::ffff:127.0.0.1 is
 * correctly rejected as loopback.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  // Normalize IPv4-mapped IPv6 to classify the embedded IPv4.
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      const mapped = v6.toIPv4Address();
      return mapped.range() === "unicast";
    }
  }
  return parsed.range() === "unicast";
}

/**
 * Validate the destination host of an already-parsed URL. IP-literal hosts
 * (e.g. `http://127.0.0.1/`) are classified directly here because Node's
 * net.connect does NOT call connect.lookup for IP literals — it connects
 * straight to the address, which would bypass the validating DNS lookup.
 * DNS-name hosts are left to the validating lookup at connection time.
 *
 * Throws SafeFetchErrorClass("blocked_destination") for a private/reserved
 * IP-literal host. Throws nothing for DNS names (handled at connect time).
 */
function assertHostAllowed(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new SafeFetchErrorClass("invalid_url", "invalid host");
  }
  if (hostname === "") {
    throw new SafeFetchErrorClass("blocked_destination", "missing host");
  }
  // URL.hostname returns IPv6 literals WITH surrounding brackets, e.g.
  // http://[::1]/ -> "[::1]". ipaddr.parse rejects the bracketed form, so a
  // bracketed host would be misclassified as a DNS name and skip this gate.
  // Strip the brackets before attempting an IP-literal parse.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  // Try to parse as an IP literal. If it parses, classify it here because
  // Node's net.connect does NOT call connect.lookup for IP literals.
  try {
    ipaddr.parse(hostname);
  } catch {
    // Not an IP literal — it's a DNS name; the validating lookup handles it.
    return;
  }
  // It IS an IP literal: classify it. Reuse isPublicAddress so IPv4-mapped
  // IPv6 and reserved ranges are handled identically to DNS answers.
  if (!isPublicAddress(hostname)) {
    throw new SafeFetchErrorClass("blocked_destination", "private ip literal");
  }
}

// ---------------------------------------------------------------------------
// DNS resolver seam
// ---------------------------------------------------------------------------

/** A hostname -> addresses resolver. Injected for tests; production uses
 * node:dns/promises lookup with verbatim:true. */
export type DnsResolver = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

/**
 * Hard ceiling on a single DNS resolution. Node's dns.lookup has no built-in
 * timeout — it relies on the OS getaddrinfo, which can hang for tens of seconds
 * against a non-responsive resolver. undici does not wire the request AbortSignal
 * to the lookup phase, so a hung lookup would outlive the per-request deadline
 * returned to the caller, dangling a connection attempt. This bound fails the
 * lookup fast (well under every caller's timeoutMs) so no DNS work lingers.
 */
export const DNS_LOOKUP_TIMEOUT_MS = 8000;

/** Race a promise against a timeout, rejecting with a coded error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("dns lookup timed out"), { code })),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Production resolver: all addresses, verbatim (no OS reordering), bounded by
 * {@link DNS_LOOKUP_TIMEOUT_MS} so a hung getaddrinfo cannot outlive the request. */
export const defaultResolver: DnsResolver = async (hostname) => {
  // verbatim:true asks the resolver to return addresses in the order the
  // underlying getaddrinfo produced them, without the OS shuffling them. We
  // validate every answer, so ordering does not change the verdict, but
  // verbatim keeps behavior deterministic.
  const lookup = dnsLookup(hostname, { all: true, verbatim: true });
  // A hung lookup surfaces as a resolver error, which makeValidatingLookup
  // forwards to the socket as EAI_AGAIN-ish; the request then fails fast.
  return withTimeout(lookup, DNS_LOOKUP_TIMEOUT_MS, "ETIMEDOUT");
};

/**
 * Build the validating undici `lookup` for a single connection. It resolves the
 * hostname, checks EVERY answer (a single private answer in a mixed set fails
 * the whole request), and returns only validated public addresses to the socket.
 * Returning validated addresses to net/tls.connect is what binds the check to
 * the connection actually used.
 *
 * Honors the `all` option in the lookup call: undici invokes connect.lookup with
 * `{ all: true }`, whose callback contract is `callback(err, addresses[])`; when
 * `all` is absent/false the contract is `callback(err, address, family)`.
 */
export function makeValidatingLookup(resolver: DnsResolver) {
  return async (
    hostname: string,
    options: { all?: boolean } | null,
    callback: (
      err: NodeJS.ErrnoException | null,
      addressOrAddresses: string | LookupAddress[] | null,
      family?: number,
    ) => void,
  ): Promise<void> => {
    let addresses: readonly LookupAddress[];
    try {
      addresses = await resolver(hostname);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      callback(err, "", 4);
      return;
    }
    if (addresses.length === 0) {
      callback(
        Object.assign(new Error("no DNS answers"), { code: "ENOTFOUND" }) as NodeJS.ErrnoException,
        "",
        4,
      );
      return;
    }
    // Reject if ANY answer is unsafe — do not pick a convenient public one from
    // a mixed set. This defeats DNS rebinding that returns a public + private.
    for (const a of addresses) {
      if (!isPublicAddress(a.address)) {
        const err = Object.assign(
          new Error("blocked private destination"),
          { code: "ECONNREFUSED" },
        ) as NodeJS.ErrnoException;
        callback(err, "", 4);
        return;
      }
    }
    // All answers are public. Return them in the shape the caller asked for:
    // the array form for all:true (what undici requests), the single-address
    // form otherwise. Both carry only already-validated addresses, so rebinding
    // to any of them later is still safe.
    if (options !== null && options.all === true) {
      callback(null, [...addresses] as LookupAddress[], undefined);
      return;
    }
    const chosen = addresses[0];
    callback(null, chosen.address, chosen.family);
  };
}

/** Build a production undici Agent whose connections use the validating lookup. */
export function makeSafeDispatcher(resolver: DnsResolver = defaultResolver): Dispatcher {
  // undici forwards connect options to net.connect/tls.connect, so `lookup`
  // here is the resolver used when establishing the socket.
  return new Agent({
    connect: { lookup: makeValidatingLookup(resolver) as never },
  });
}

/**
 * A single shared production dispatcher (Agent) reused across safeFetch calls.
 * undici Agents own a connection pool; creating one per request defeats pooling
 * and leaks sockets. This Agent is created once per process with the default
 * validating resolver. Tests inject their own dispatcher and never touch this.
 */
let sharedDispatcher: Dispatcher | undefined;

/** Return the process-wide shared validating dispatcher, creating it on first use. */
export function getSharedDispatcher(): Dispatcher {
  if (sharedDispatcher === undefined) {
    sharedDispatcher = makeSafeDispatcher(defaultResolver);
  }
  return sharedDispatcher;
}

// ---------------------------------------------------------------------------
// Result type (narrow — never exposes the raw Response)
// ---------------------------------------------------------------------------

export type SafeFetchOk = {
  ok: true;
  /** Final, policy-validated URL after following redirects. Safe to log:
   * credentials are rejected at parse time; query strings may be present, so
   * callers that carry secrets in the query must redact before logging. */
  finalUrl: string;
  status: number;
  contentType: string;
  /** Bounded body bytes. Never larger than the requested maxBytes. */
  bytes: Uint8Array;
};

export type SafeFetchResult =
  | SafeFetchOk
  | { ok: false; code: SafeFetchError };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type SafeFetchOptions = {
  /** Total deadline in ms, covering DNS resolution and every redirect hop. */
  timeoutMs: number;
  /** Hard cap on streamed body bytes, enforced even if Content-Length is absent
   * or the server ignores Range. */
  maxBytes: number;
  /** Content-type allow predicate. Defaults to allowing any. */
  allowContentType?: (contentType: string) => boolean;
  /** Optional extra headers (e.g. Range, User-Agent). Must not carry secrets. */
  headers?: Record<string, string>;
  /** Maximum redirects AFTER the initial request. */
  maxRedirects?: number;
  /** Injected for tests. Production omits and uses a validating undici Agent. */
  dispatcher?: Dispatcher;
  /** Injected clock for tests. */
  now?: () => number;
  /** Behavior when the streamed body exceeds `maxBytes`.
   * - `"error"` (default): throw `response_too_large` so the caller can fail
   *   the item.
   * - `"truncate"`: stop reading at `maxBytes`, dump the remainder, and return
   *   the bounded bytes as a successful result. Use for text pages where a
   *   truncated prefix is still useful. */
  onOverflow?: "error" | "truncate";
};

const DEFAULT_MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Bounded reader
// ---------------------------------------------------------------------------

/** Read at most `maxBytes` from an undici response body, enforcing the cap
 * even when Content-Length is missing or lied about.
 *
 * When `onOverflow` is `"error"` (the default), exceeding the cap throws
 * `response_too_large`. When `"truncate"`, the reader stops at `maxBytes`,
 * dumps the remainder, and returns the bounded prefix as a successful result. */
async function readBounded(
  body: BodyReadable,
  maxBytes: number,
  signal: AbortSignal,
  onOverflow: "error" | "truncate" = "error",
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    if (signal.aborted) {
      throw new SafeFetchErrorClass("timeout", "deadline exceeded while reading body");
    }
    total += chunk.length;
    if (total > maxBytes) {
      if (onOverflow === "truncate") {
        // Keep only the bytes up to the cap, dump the rest, return the prefix.
        const excess = total - maxBytes;
        const kept = chunk.slice(0, chunk.length - excess);
        if (kept.length > 0) chunks.push(kept);
        await safeDump(body);
        // safeDump swallows abort errors raised while draining. Re-check the
        // signal so a deadline that fires during the dump is surfaced as a
        // timeout instead of a successful truncated result.
        if (signal.aborted) {
          throw new SafeFetchErrorClass("timeout", "deadline exceeded while draining overflow");
        }
        return new Uint8Array(Buffer.concat(chunks));
      }
      // Over cap in error mode: cancel the body by dumping the remainder.
      await safeDump(body);
      throw new SafeFetchErrorClass("response_too_large", "body exceeded max bytes");
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

/**
 * Fetch an external URL with the full safe-fetch policy. Resolves to a narrow
 * result; never throws SafeFetchErrorClass (errors are encoded in the result).
 * Internal helper `safeFetchThrowing` uses throwing for natural control flow;
 * the public `safeFetch` wrapper catches and converts to the result type.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  return safeFetchThrowing(rawUrl, options).then(
    (value) => ({ ok: true, ...value }) as SafeFetchOk,
    (e: unknown) => {
      if (isSafeFetchError(e)) {
        return { ok: false, code: e.code };
      }
      if (isUrlPolicyError(e)) {
        return { ok: false, code: e.code };
      }
      return { ok: false, code: "fetch_failed" };
    },
  );
}

async function safeFetchThrowing(
  rawUrl: string,
  options: SafeFetchOptions,
): Promise<Omit<SafeFetchOk, "ok">> {
  const {
    timeoutMs,
    maxBytes,
    allowContentType = () => true,
    headers = {},
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    dispatcher = getSharedDispatcher(),
    onOverflow = "error",
  } = options;

  // Re-validate the URL syntactically on entry. external-url enforces scheme,
  // credentials, port, host, and length. We keep the canonical string so every
  // subsequent hop is compared against a normalized form.
  let currentUrl = normalizeExternalUrl(rawUrl);
  // IP-literal destinations are NOT routed through connect.lookup (Node's
  // net.connect connects to IP literals directly), so validate them here and
  // on every redirect. DNS hostnames are validated at connection time by the
  // validating lookup. This closes the http://127.0.0.1/ SSRF path.
  assertHostAllowed(currentUrl);

  // One total deadline covering DNS and all hops. Created before the loop so a
  // resolver that never completes still aborts.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    let redirects = 0;
    // The first request counts as the initial; up to maxRedirects may follow.
    for (;;) {
      if (ac.signal.aborted) {
        throw new SafeFetchErrorClass("timeout", "deadline exceeded");
      }
      const response = await dispatch(dispatcher, currentUrl, headers, ac.signal);
      // The response body must always be consumed or cancelled. We either
      // follow a redirect (cancel body, continue), error (cancel body, throw),
      // or return (read bounded body).
      if (response.statusCode >= 300 && response.statusCode < 400) {
        await safeDump(response.body);
        if (redirects >= maxRedirects) {
          throw new SafeFetchErrorClass("redirect_limit", "too many redirects");
        }
        const location = response.headers["location"];
        if (typeof location !== "string" || location === "") {
          throw new SafeFetchErrorClass("fetch_failed", "redirect without Location");
        }
        // Resolve relative Location against the current URL, then re-run full
        // URL policy (scheme, credentials, port, length).
        let nextUrl: string;
        try {
          nextUrl = normalizeExternalUrl(new URL(location, currentUrl).toString());
        } catch (e) {
          if (isUrlPolicyError(e)) {
            throw new SafeFetchErrorClass(
              e.code,
              "redirect target rejected by url policy",
            );
          }
          throw new SafeFetchErrorClass("fetch_failed", "invalid redirect target");
        }
        // Re-check IP-literal destinations on the redirect target too (a public
        // page can redirect to a private IP literal).
        try {
          assertHostAllowed(nextUrl);
        } catch (e) {
          if (isSafeFetchError(e)) {
            throw e;
          }
          throw new SafeFetchErrorClass(
            "blocked_destination",
            "redirect target rejected",
          );
        }
        redirects++;
        currentUrl = nextUrl;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await safeDump(response.body);
        throw new SafeFetchErrorClass(
          "http_error",
          `http status ${response.statusCode}`,
        );
      }
      const contentType = String(response.headers["content-type"] ?? "");
      // Media types are case-insensitive (RFC 9110 §8.3.1). Call-site predicates
      // match lowercase literals (text/html, image/, application/json), so a
      // server sending `Text/HTML` or `IMAGE/JPEG` would wrongly be rejected.
      // Lowercase once here so every predicate sees a normalized value.
      if (!allowContentType(contentType.toLowerCase())) {
        await safeDump(response.body);
        throw new SafeFetchErrorClass(
          "unsupported_content_type",
          "content type not allowed",
        );
      }
      // Pre-check a declared Content-Length against the cap before streaming.
      // Skip this pre-check in truncate mode — the reader will stop at maxBytes
      // and return the prefix instead of failing.
      if (onOverflow === "error") {
        const declared = response.headers["content-length"];
        if (typeof declared === "string") {
          const len = Number(declared);
          if (Number.isFinite(len) && len > maxBytes) {
            await safeDump(response.body);
            throw new SafeFetchErrorClass("response_too_large", "content-length over cap");
          }
        }
      }
      const bytes = await readBounded(response.body, maxBytes, ac.signal, onOverflow);
      return {
        finalUrl: currentUrl,
        status: response.statusCode,
        contentType,
        bytes,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Issue a single GET request through the dispatcher. undici's request() uses
 * the dispatcher's connect.lookup (our validating resolver) for DNS. We race
 * the request against an explicit abort listener so the total deadline fires
 * even if a dispatcher ignores the signal. */
async function dispatch(
  dispatcher: Dispatcher,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Dispatcher.ResponseData> {
  const parsed = new URL(url);
  // Abort races the request. If the deadline fires first, reject with timeout.
  const abortRace = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new SafeFetchErrorClass("timeout", "deadline exceeded"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new SafeFetchErrorClass("timeout", "deadline exceeded")),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      dispatcher.request({
        method: "GET",
        origin: parsed.origin,
        path: parsed.pathname + parsed.search,
        headers,
        signal,
      }),
      abortRace,
    ]);
  } catch (e) {
    // Translate a raw transport error into a safe-fetch error. We must not
    // leak the URL (it may carry a query secret) — only a code propagates.
    if (e instanceof SafeFetchErrorClass) {
      throw e;
    }
    const err = e as NodeJS.ErrnoException;
    // The validating lookup blocks a private destination with ECONNREFUSED.
    // Map only that marker to blocked_destination so a genuine network failure
    // (ECONNRESET, EHOSTUNREACH, etc.) is reported as fetch_failed instead.
    // Check this before signal.aborted: under a near-simultaneous block + abort,
    // a genuinely blocked destination should be reported as such, not as timeout.
    if (err !== null && typeof err === "object" && err.code === "ECONNREFUSED") {
      throw new SafeFetchErrorClass("blocked_destination", "request failed");
    }
    if (signal.aborted) {
      throw new SafeFetchErrorClass("timeout", "deadline exceeded");
    }
    throw new SafeFetchErrorClass("fetch_failed", "request failed");
  }
}

/** Best-effort dump of a response body so the connection is released. */
async function safeDump(body: BodyReadable | null | undefined): Promise<void> {
  if (body === null || body === undefined) {
    return;
  }
  try {
    await body.dump();
  } catch {
    // Cancellation is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Convenience readers (operate on the already-bounded bytes)
// ---------------------------------------------------------------------------

/** Decode bounded bytes as text using UTF-8. The stream cap already bounded
 * the size; this just converts. Callers should still slice for their needs. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Decode bounded bytes as text, honoring the charset declared in the
 * Content-Type header. Extracts `charset=...` from the header (case-insensitive),
 * uses it if Node's TextDecoder supports it, and falls back to UTF-8 when the
 * charset is absent or unsupported. This avoids mojibake on pages served as
 * ISO-8859-1, Windows-1252, Shift_JIS, etc. */
export function decodeWithContentType(
  bytes: Uint8Array,
  contentType: string,
): string {
  const match = contentType.match(/charset\s*=\s*["']?([\w-]+)/i);
  const charset = match?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unsupported charset label — fall back to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Parse bounded bytes as JSON. Throws on invalid JSON. */
export function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(decodeUtf8(bytes));
}
