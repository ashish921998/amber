import { describe, expect, it } from "vitest";

import { displayHost, isProbablyUrl } from "./url";

describe("isProbablyUrl", () => {
  it("recognizes a URL with and without an https scheme", () => {
    expect(isProbablyUrl("https://example.com")).toBe(true);
    expect(isProbablyUrl("example.com")).toBe(true);
  });

  it("rejects internal whitespace even when the trimmed value looks like a host", () => {
    expect(isProbablyUrl("example.com some words")).toBe(false);
  });
});

describe("displayHost", () => {
  it("strips the scheme and leading www", () => {
    expect(displayHost("https://www.example.com/path?q=1")).toBe("example.com");
  });

  it("falls back to the raw input when it cannot be parsed as a URL", () => {
    expect(displayHost("not a url")).toBe("not a url");
  });

  it("returns an empty string for undefined input", () => {
    expect(displayHost(undefined)).toBe("");
  });
});
