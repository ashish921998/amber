/**
 * Syntactic URL normalization and policy for user-supplied link URLs.
 *
 * This module is runtime-agnostic: it has no Node-only imports, so it can be
 * used from Convex mutations (default V8 runtime) and from Node actions alike.
 * It validates only the *form* of a URL — scheme, host, port, credentials,
 * length. It does NOT resolve DNS or inspect the destination address; that is
 * the job of `safeFetch.ts` at request time, bound to the actual connection.
 *
 * Network destination safety (private/reserved IP ranges, DNS answers) lives in
 * `safeFetch.ts` because it requires Node-only libraries.
 */

/** Policy error categories. Stable codes used by callers and logs; never the
 * internal parser text or the offending URL. */
export type UrlPolicyError =
  | "empty"
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_not_allowed"
  | "invalid_host"
  | "invalid_port"
  | "url_too_long";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Hard cap on normalized URL length in UTF-16 code units (string `.length`).
 * Generous for real links, bounded to deny pathological input. */
export const MAX_URL_LENGTH = 2048;

export class UrlPolicyErrorClass extends Error {
  constructor(
    public readonly code: UrlPolicyError,
    message: string,
  ) {
    super(message);
    this.name = "UrlPolicyError";
  }
}

export function isUrlPolicyError(e: unknown): e is UrlPolicyErrorClass {
  return e instanceof UrlPolicyErrorClass;
}

/**
 * Normalize and policy-check a user-supplied link string.
 *
 * - trims input and prepends `https://` only when no scheme is present;
 * - parses with `new URL`;
 * - accepts only `http:` and `https:`;
 * - rejects username/password, empty hostname, invalid ports, and any explicit
 *   non-default port (e.g. `:8080`); explicit default ports (`http://…:80`,
 *   `https://…:443`) are dropped by the URL serializer's canonical form and are
 *   accepted;
 * - rejects URLs longer than {@link MAX_URL_LENGTH} UTF-16 code units after
 *   normalization;
 * - normalizes to the URL serializer's canonical string.
 *
 * Scheme detection is scheme-aware, not a `://` substring test: the input is
 * parsed as-is first, so single-colon schemes (`javascript:`, `data:`,
 * `localhost:3000`) are recognized as having a scheme and rejected as
 * unsupported rather than mis-prefixed.
 *
 * @returns the canonical URL string on success.
 * @throws {UrlPolicyErrorClass} with a stable code on any policy violation.
 */
export function normalizeExternalUrl(raw: string): string {
  if (typeof raw !== "string") {
    throw new UrlPolicyErrorClass("invalid_url", "URL must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new UrlPolicyErrorClass("empty", "URL is empty");
  }

  // Decide whether the input already carries a scheme. A scheme is the leading
  // "<name>:" token; we detect it explicitly so that schemeless input (e.g.
  // "example.com") gets https:// prepended, while an explicit scheme is honored
  // and rejected as unsupported if it isn't http(s). Detecting the scheme up
  // front (rather than blindly retrying with an https:// prefix after a parse
  // failure) prevents "https://" alone from being rescued into a bogus host.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);

  let parsed: URL;
  if (hasScheme) {
    // Input has a scheme — parse as-is so we can report its real scheme.
    try {
      parsed = new URL(trimmed);
    } catch {
      // Parsed-here-but-bad (e.g. "https://" with no host): the input declared
      // an http(s)-style scheme but is not a complete URL.
      throw new UrlPolicyErrorClass("invalid_host", "URL has no host");
    }
  } else {
    // Schemeless — prepend https:// and parse the canonical form.
    try {
      parsed = new URL(`https://${trimmed}`);
    } catch {
      throw new UrlPolicyErrorClass("invalid_url", "URL is not valid");
    }
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new UrlPolicyErrorClass("unsupported_scheme", "Only http(s) URLs are allowed");
  }
  // The URL serializer exposes username/password via these getters even when
  // absent from the original string for some hosts; check the raw userInfo part.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UrlPolicyErrorClass(
      "credentials_not_allowed",
      "Credentials are not allowed in URLs",
    );
  }
  if (parsed.hostname === "") {
    throw new UrlPolicyErrorClass("invalid_host", "URL has no host");
  }
  // An explicit non-default port survives in parsed.port (the URL serializer
  // strips only the *default* port for the scheme). Any remaining port is
  // non-default and is rejected — we only ever fetch standard web endpoints.
  if (parsed.port !== "") {
    throw new UrlPolicyErrorClass("invalid_port", "Non-default ports are not allowed");
  }

  const canonical = parsed.href;
  if (canonical.length > MAX_URL_LENGTH) {
    throw new UrlPolicyErrorClass("url_too_long", "URL exceeds maximum length");
  }
  return canonical;
}


