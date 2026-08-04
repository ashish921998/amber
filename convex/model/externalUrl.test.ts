import { describe, expect, it } from "vitest";

import {
  isUrlPolicyError,
  MAX_URL_LENGTH,
  normalizeExternalUrl,
} from "./externalUrl";

/** Assert the policy code thrown by normalizeExternalUrl for a given input. */
function expectCode(raw: string, code: string): void {
  expect(() => normalizeExternalUrl(raw)).toThrow();
  try {
    normalizeExternalUrl(raw);
  } catch (e) {
    expect(isUrlPolicyError(e) ? e.code : "not_a_policy_error").toBe(code);
  }
}

describe("normalizeExternalUrl - scheme handling", () => {
  it("prepends https:// when no scheme is present", () => {
    expect(normalizeExternalUrl("example.com")).toBe("https://example.com/");
    expect(normalizeExternalUrl("  example.com/path  ")).toBe(
      "https://example.com/path",
    );
  });

  it("keeps an existing http(s) scheme unchanged in form", () => {
    expect(normalizeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(normalizeExternalUrl("https://example.com")).toBe("https://example.com/");
  });

  it("rejects non-http schemes, including single-colon schemes", () => {
    expectCode("file:///etc/passwd", "unsupported_scheme");
    expectCode("gopher://example.com", "unsupported_scheme");
    expectCode("data:text/html,<x>", "unsupported_scheme");
    expectCode("javascript:alert(1)", "unsupported_scheme");
    expectCode("ftp://example.com", "unsupported_scheme");
    // WHATWG URL parses "example.com:8080" with scheme "example.com:"; the
    // scheme-aware detector rejects it as unsupported rather than treating it
    // as a bare host with a port.
    expectCode("example.com:8080", "unsupported_scheme");
    expectCode("localhost:3000", "unsupported_scheme");
  });

  it("does not treat a scheme-like substring mid-string as a scheme", () => {
    // No leading scheme -> https:// is prepended; the inner "://" is just path.
    expect(normalizeExternalUrl("example.com/http://evil.com")).toBe(
      "https://example.com/http://evil.com",
    );
  });
});

describe("normalizeExternalUrl - credentials", () => {
  it("rejects embedded username", () => {
    expectCode("https://user@example.com", "credentials_not_allowed");
    expectCode("https://user:pass@example.com", "credentials_not_allowed");
  });
  it("rejects embedded password without username", () => {
    expectCode("https://:pass@example.com", "credentials_not_allowed");
  });
});

describe("normalizeExternalUrl - host", () => {
  it("rejects a missing host", () => {
    // "https://" declares an http(s) scheme but has no host — reported as
    // invalid_host, distinct from genuinely unparseable input.
    expectCode("https://", "invalid_host");
  });
  it("accepts fragments and query strings", () => {
    expect(normalizeExternalUrl("https://example.com/a?b=c#frag")).toBe(
      "https://example.com/a?b=c#frag",
    );
  });
});

describe("normalizeExternalUrl - ports", () => {
  it("accepts and normalizes explicit default ports", () => {
    expect(normalizeExternalUrl("http://example.com:80")).toBe("http://example.com/");
    expect(normalizeExternalUrl("https://example.com:443")).toBe(
      "https://example.com/",
    );
  });
  it("rejects non-default ports", () => {
    expectCode("https://example.com:8080", "invalid_port");
    expectCode("http://example.com:8443", "invalid_port");
    expectCode("https://example.com:1", "invalid_port");
  });
});

describe("normalizeExternalUrl - IPv4 canonicalization", () => {
  it("canonicalizes decimal IPv4", () => {
    // 167903424 decimal -> 10.2.0.192 per the WHATWG host parser.
    expect(normalizeExternalUrl("https://167903424")).toBe("https://10.2.0.192/");
  });
  it("canonicalizes hex IPv4", () => {
    // 0x0a.0x02.0x03.0x04 == 10.2.3.4
    expect(normalizeExternalUrl("https://0x0a020304")).toBe("https://10.2.3.4/");
  });
  it("canonicalizes short/legacy IPv4 forms", () => {
    // 10 -> 0.0.0.10
    expect(normalizeExternalUrl("https://10")).toBe("https://0.0.0.10/");
    // 10.2 -> 10.0.0.2
    expect(normalizeExternalUrl("https://10.2")).toBe("https://10.0.0.2/");
  });
});

describe("normalizeExternalUrl - IPv6", () => {
  it("accepts IPv6 literals", () => {
    expect(normalizeExternalUrl("https://[::1]")).toBe("https://[::1]/");
    expect(normalizeExternalUrl("https://[2001:4860:4860::8888]")).toBe(
      "https://[2001:4860:4860::8888]/",
    );
  });
});

describe("normalizeExternalUrl - length boundary", () => {
  it("rejects URLs longer than the cap", () => {
    // Build a URL whose canonical form is exactly MAX+1 code units.
    const host = "example.com";
    const base = `https://${host}/`;
    const pad = MAX_URL_LENGTH - base.length + 1;
    const raw = base + "a".repeat(pad);
    expect(raw.length).toBe(MAX_URL_LENGTH + 1);
    expectCode(raw, "url_too_long");
  });
  it("accepts URLs exactly at the cap", () => {
    const host = "example.com";
    const base = `https://${host}/`;
    const pad = MAX_URL_LENGTH - base.length;
    const raw = base + "a".repeat(pad);
    expect(raw.length).toBe(MAX_URL_LENGTH);
    expect(normalizeExternalUrl(raw).length).toBe(MAX_URL_LENGTH);
  });
});

describe("normalizeExternalUrl - empty / invalid", () => {
  it("rejects empty and whitespace-only input", () => {
    expectCode("", "empty");
    expectCode("   ", "empty");
  });
  it("rejects malformed input", () => {
    // An http(s)-schemed input that fails to parse is reported as invalid_host
    // (the scheme was recognized but the URL is incomplete).
    expectCode("https://exa mple.com", "invalid_host");
    // Genuinely unparseable schemeless garbage is invalid_url.
    expectCode("exa mple", "invalid_url");
  });
});
