// Node environment by default (no edge-runtime pragma). safeFetch imports
// undici (node:net/node:tls) which will not load under @edge-runtime/vm.
import { describe, expect, it } from "vitest";

import {
  defaultResolver,
  isPublicAddress,
  makeValidatingLookup,
  safeFetch,
  decodeWithContentType,
} from "./safeFetch";
import type { DnsResolver } from "./safeFetch";
import { MockAgent, type Dispatcher } from "undici";

// ---------------------------------------------------------------------------
// Helper: build a resolver that returns canned answers for any hostname.
// ---------------------------------------------------------------------------
function resolverFor(addresses: string[]): DnsResolver {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

// ---------------------------------------------------------------------------
// IP / address classification
// ---------------------------------------------------------------------------

describe("isPublicAddress", () => {
  it("rejects loopback", () => {
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("127.255.255.255")).toBe(false);
  });
  it("rejects RFC1918 private ranges", () => {
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("172.16.0.1")).toBe(false);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
  });
  it("rejects link-local", () => {
    expect(isPublicAddress("169.254.169.254")).toBe(false); // cloud metadata
    expect(isPublicAddress("169.254.0.1")).toBe(false);
  });
  it("rejects multicast", () => {
    expect(isPublicAddress("224.0.0.1")).toBe(false);
  });
  it("rejects unspecified", () => {
    expect(isPublicAddress("0.0.0.0")).toBe(false);
  });
  it("rejects reserved/documentation ranges", () => {
    expect(isPublicAddress("240.0.0.1")).toBe(false); // class E reserved
    expect(isPublicAddress("203.0.113.1")).toBe(false); // TEST-NET-3 doc
    expect(isPublicAddress("198.51.100.1")).toBe(false); // TEST-NET-2 doc
    expect(isPublicAddress("192.0.2.1")).toBe(false); // TEST-NET-1 doc
  });
  it("rejects IPv6 loopback and link-local", () => {
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("fe80::1")).toBe(false);
  });
  it("rejects IPv4-mapped IPv6 of a private address", () => {
    // ::ffff:127.0.0.1 must be classified via the embedded IPv4 (loopback).
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
  });
  it("allows IPv4-mapped IPv6 of a public address", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  });
  it("allows globally routable public addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
  });
  it("rejects unparseable input", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection-bound DNS: the validating lookup is the resolver undici's socket
// uses. Tested directly with an injected resolver (deterministic, no network):
// it must block any private answer, block mixed answer sets, and allow only
// all-public answers. The spike (deleted before commit) additionally proved
// end-to-end that a poisoned lookup prevents a real connection.
// ---------------------------------------------------------------------------

/** Promisify the node-style callback signature makeValidatingLookup returns,
 * in the single-address form (all:false / absent). */
async function runLookup(
  lookup: ReturnType<typeof makeValidatingLookup>,
  hostname: string,
): Promise<{ err: NodeJS.ErrnoException | null; address: string; family: number }> {
  return new Promise((resolve) => {
    lookup(hostname, {}, (err, address, family) =>
      resolve({ err, address: address as string, family: family as number }),
    );
  });
}

/** Promisify the lookup in the all:true form (what undici actually requests). */
async function runLookupAll(
  lookup: ReturnType<typeof makeValidatingLookup>,
  hostname: string,
): Promise<{
  err: NodeJS.ErrnoException | null;
  addresses: import("node:dns").LookupAddress[] | null;
}> {
  return new Promise((resolve) => {
    lookup(hostname, { all: true }, (err, addresses) =>
      resolve({
        err,
        addresses: addresses as import("node:dns").LookupAddress[] | null,
      }),
    );
  });
}

describe("makeValidatingLookup (connection-bound DNS)", () => {
  it("blocks a private DNS answer with ECONNREFUSED before a socket opens", async () => {
    const lookup = makeValidatingLookup(resolverFor(["127.0.0.1"]));
    const { err, address } = await runLookup(lookup, "anything.test");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("ECONNREFUSED");
    // No address is returned to the socket — it cannot connect.
    expect(address).toBe("");
  });

  it("blocks when DNS returns a MIXED public+private answer set", async () => {
    const lookup = makeValidatingLookup(resolverFor(["8.8.8.8", "127.0.0.1"]));
    const { err } = await runLookup(lookup, "mixed.test");
    expect(err?.code).toBe("ECONNREFUSED");
  });

  it("blocks cloud-metadata link-local addresses", async () => {
    const lookup = makeValidatingLookup(resolverFor(["169.254.169.254"]));
    const { err } = await runLookup(lookup, "metadata.test");
    expect(err?.code).toBe("ECONNREFUSED");
  });

  it("blocks an IPv4-mapped IPv6 private answer", async () => {
    const lookup = makeValidatingLookup(resolverFor(["::ffff:127.0.0.1"]));
    const { err } = await runLookup(lookup, "mapped.test");
    expect(err?.code).toBe("ECONNREFUSED");
  });

  it("returns the validated public address when ALL answers are public", async () => {
    const lookup = makeValidatingLookup(resolverFor(["8.8.8.8", "1.1.1.1"]));
    const { err, address, family } = await runLookup(lookup, "public.test");
    expect(err).toBeNull();
    expect(address).toBe("8.8.8.8");
    expect(family).toBe(4);
  });

  it("returns ENOTFOUND when the resolver gives no answers", async () => {
    const lookup = makeValidatingLookup(resolverFor([]));
    const { err } = await runLookup(lookup, "none.test");
    expect(err?.code).toBe("ENOTFOUND");
  });

  it("propagates a resolver error", async () => {
    const lookup = makeValidatingLookup(async () => {
      throw Object.assign(new Error("dns down"), { code: "ESERVFAIL" });
    });
    const { err } = await runLookup(lookup, "broken.test");
    expect(err?.code).toBe("ESERVFAIL");
  });

  it("returns the array form when called with all:true (undici's actual shape)", async () => {
    // undici invokes connect.lookup with { all: true }, whose callback contract
    // is callback(err, addresses[]). Returning the single-address form here
    // breaks every DNS-hostname fetch with "Invalid IP address: undefined".
    const lookup = makeValidatingLookup(resolverFor(["8.8.8.8", "1.1.1.1"]));
    const { err, addresses } = await runLookupAll(lookup, "public.test");
    expect(err).toBeNull();
    expect(addresses).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);
  });

  it("blocks in the all:true form too when an answer is private", async () => {
    const lookup = makeValidatingLookup(resolverFor(["8.8.8.8", "127.0.0.1"]));
    const { err, addresses } = await runLookupAll(lookup, "mixed.test");
    expect(err?.code).toBe("ECONNREFUSED");
    // On error the lookup returns no address array (the second arg is unused).
    expect(Array.isArray(addresses)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS lookup deadline: defaultResolver must fail fast when getaddrinfo hangs,
// so no DNS work outlives the request (undici does not wire the AbortSignal to
// the lookup phase). We can't easily hang the real getaddrinfo, so assert the
// resolver rejects promptly for an already-failing lookup with the coded error.
// ---------------------------------------------------------------------------

describe("defaultResolver deadline", () => {
  it("rejects (does not hang) when the underlying lookup fails", async () => {
    // A domain that will not resolve -> getaddrinfo fails fast rather than
    // hanging. The point is that the resolver surfaces a rejection (coded),
    // which makeValidatingLookup forwards, instead of lingering indefinitely.
    await expect(defaultResolver("nonexistent.invalid.local.test")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HTTP policy via injected MockAgent dispatcher (deterministic, no network).
// ---------------------------------------------------------------------------

/** Configure a MockAgent and return it as the injected dispatcher. */
function mockDispatcher(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

describe("safeFetch HTTP policy", () => {
  it("returns bounded bytes on a 200", async () => {
    const agent = mockDispatcher();
    const pool = agent.get("http://example.test");
    pool.intercept({ method: "GET", path: "/" }).reply(200, "hello", {
      headers: { "content-type": "text/html" },
    });
    const result = await safeFetch("http://example.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(new TextDecoder().decode(result.bytes)).toBe("hello");
      expect(result.contentType).toContain("text/html");
    }
  });

  it("follows a public redirect chain within the hop limit", async () => {
    const agent = mockDispatcher();
    const a = agent.get("http://a.test");
    a.intercept({ method: "GET", path: "/" }).reply(302, "", {
      headers: { location: "http://b.test/" },
    });
    const b = agent.get("http://b.test");
    b.intercept({ method: "GET", path: "/" }).reply(200, "final", {
      headers: { "content-type": "text/html" },
    });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl).toBe("http://b.test/");
      expect(new TextDecoder().decode(result.bytes)).toBe("final");
    }
  });

  it("resolves a relative Location against the current URL", async () => {
    const agent = mockDispatcher();
    const a = agent.get("http://a.test");
    a.intercept({ method: "GET", path: "/start" }).reply(302, "", {
      headers: { location: "/end" },
    });
    a.intercept({ method: "GET", path: "/end" }).reply(200, "x", {
      headers: { "content-type": "text/html" },
    });
    const result = await safeFetch("http://a.test/start", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalUrl).toBe("http://a.test/end");
    }
  });

  it("rejects a non-http redirect scheme", async () => {
    const agent = mockDispatcher();
    const a = agent.get("http://a.test");
    a.intercept({ method: "GET", path: "/" }).reply(302, "", {
      headers: { location: "file:///etc/passwd" },
    });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_scheme");
    }
  });

  it("rejects a credentialed redirect target", async () => {
    const agent = mockDispatcher();
    const a = agent.get("http://a.test");
    a.intercept({ method: "GET", path: "/" }).reply(302, "", {
      headers: { location: "http://user:pass@b.test/" },
    });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("credentials_not_allowed");
    }
  });

  it("rejects on the fourth redirect (boundary: third hop allowed)", async () => {
    const agent = mockDispatcher();
    // Hops: a(302)->b(302)->c(302)->d(302)->e. maxRedirects=3 means after the
    // initial request up to 3 redirects are followed; the 4th redirect (d->e)
    // must be rejected. Initial to a is hop 0; a->b (1), b->c (2), c->d (3),
    // then d responds 302 again which is the 4th redirect -> limit.
    const setRedirect = (host: string, target: string) => {
      agent.get(host).intercept({ method: "GET", path: "/" }).reply(302, "", {
        headers: { location: target },
      });
    };
    setRedirect("http://a.test", "http://b.test/");
    setRedirect("http://b.test", "http://c.test/");
    setRedirect("http://c.test", "http://d.test/");
    setRedirect("http://d.test", "http://e.test/");
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("redirect_limit");
    }
  });

  it("rejects an http error status", async () => {
    const agent = mockDispatcher();
    agent.get("http://a.test").intercept({ method: "GET", path: "/" }).reply(500, "");
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("http_error");
    }
  });

  it("rejects a disallowed content type", async () => {
    const agent = mockDispatcher();
    agent
      .get("http://a.test")
      .intercept({ method: "GET", path: "/" })
      .reply(200, "binary", { headers: { "content-type": "application/octet-stream" } });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
      allowContentType: (ct) => ct.startsWith("text/"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_content_type");
    }
  });

  it("normalizes content type case-insensitively (RFC 9110)", async () => {
    // A server may send "Text/HTML"; call-site predicates match lowercase, so
    // the fetcher must lowercase the header before invoking the predicate.
    const agent = mockDispatcher();
    agent
      .get("http://a.test")
      .intercept({ method: "GET", path: "/" })
      .reply(200, "ok", { headers: { "content-type": "Text/HTML" } });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
      allowContentType: (ct) => ct.startsWith("text/html"),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a lying Content-Length over the cap", async () => {
    const agent = mockDispatcher();
    agent
      .get("http://a.test")
      .intercept({ method: "GET", path: "/" })
      .reply(200, Buffer.alloc(100), {
        headers: { "content-type": "text/html", "content-length": "100" },
      });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 50,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("response_too_large");
    }
  });

  it("rejects an oversized stream when Content-Length is missing", async () => {
    const agent = mockDispatcher();
    agent
      .get("http://a.test")
      .intercept({ method: "GET", path: "/" })
      .reply(200, Buffer.alloc(200), { headers: { "content-type": "text/html" } });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 50,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("response_too_large");
    }
  });

  it("truncates an oversized stream when onOverflow is 'truncate'", async () => {
    const agent = mockDispatcher();
    agent
      .get("http://a.test")
      .intercept({ method: "GET", path: "/" })
      .reply(200, Buffer.alloc(200), { headers: { "content-type": "text/html" } });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 50,
      dispatcher: agent,
      onOverflow: "truncate",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.length).toBe(50);
    }
  });

  it("truncates even when Content-Length declares more than maxBytes", async () => {
    const agent = mockDispatcher();
    agent
      .get("http://a.test")
      .intercept({ method: "GET", path: "/" })
      .reply(200, Buffer.alloc(100), {
        headers: { "content-type": "text/html", "content-length": "100" },
      });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 50,
      dispatcher: agent,
      onOverflow: "truncate",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.length).toBe(50);
    }
  });

  it("returns timeout (not a successful truncated result) when the deadline fires while draining overflow in truncate mode", async () => {
    // A body whose first chunk exceeds maxBytes (triggering the truncate
    // branch) and whose dump() outlives the deadline. safeDump swallows the
    // abort, so without the post-dump signal.aborted re-check the caller
    // would get a successful ok:true result instead of a timeout.
    const slowDumpBody = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(200);
      },
      async dump() {
        // Drain takes longer than the 100ms deadline.
        await new Promise((r) => setTimeout(r, 400));
      },
    };
    const dispatcher: Dispatcher = {
      request() {
        return Promise.resolve({
          statusCode: 200,
          headers: { "content-type": "text/html" },
          body: slowDumpBody,
        } as unknown as Dispatcher.ResponseData);
      },
      dispatch() {
        return false;
      },
      close() {
        return Promise.resolve();
      },
      destroy() {
        return Promise.resolve();
      },
    } as unknown as Dispatcher;
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 100,
      maxBytes: 50,
      dispatcher,
      onOverflow: "truncate",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
    }
  });

  it("rejects a syntactically invalid url before any request", async () => {
    const agent = mockDispatcher();
    const result = await safeFetch("javascript:alert(1)", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_scheme");
    }
  });
});

// ---------------------------------------------------------------------------
// IP-literal SSRF: Node's net.connect does NOT call connect.lookup for IP
// literals, so http://127.0.0.1/ would bypass the validating DNS lookup and
// connect straight to loopback. assertHostAllowed classifies IP-literal hosts
// before the request. These tests use a RECORDING dispatcher and assert
// request() is NEVER called — proving the block happens before dispatch, not
// as a side effect of the dispatcher refusing the connection.
// ---------------------------------------------------------------------------

/** A dispatcher that records whether request() was ever invoked. Any call
 * means the SSRF gate FAILED to block the URL before dispatch. */
function recordingDispatcher(): { dispatcher: Dispatcher; called: () => boolean } {
  let called = false;
  const dispatcher = {
    request() {
      called = true;
      return Promise.reject(new Error("should not have been called"));
    },
  } as unknown as Dispatcher;
  return { dispatcher, called: () => called };
}

describe("safeFetch IP-literal SSRF block", () => {
  it("rejects loopback IP literals before dispatch", async () => {
    const rec = recordingDispatcher();
    const result = await safeFetch("http://127.0.0.1/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: rec.dispatcher,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("blocked_destination");
    }
    expect(rec.called()).toBe(false);
  });

  it("rejects RFC1918 private IP literals before dispatch", async () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "192.168.1.1"]) {
      const rec = recordingDispatcher();
      const result = await safeFetch(`http://${ip}/`, {
        timeoutMs: 2000,
        maxBytes: 1024,
        dispatcher: rec.dispatcher,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("blocked_destination");
      }
      expect(rec.called()).toBe(false);
    }
  });

  it("rejects cloud-metadata link-local IP literal before dispatch", async () => {
    const rec = recordingDispatcher();
    const result = await safeFetch("http://169.254.169.254/latest/meta-data/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: rec.dispatcher,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("blocked_destination");
    }
    expect(rec.called()).toBe(false);
  });

  it("rejects IPv6 loopback literal before dispatch (bracket stripping)", async () => {
    // Regression: URL.hostname returns "[::1]" with brackets; ipaddr.parse
    // rejects the bracketed form, so without bracket stripping this bypassed
    // the gate entirely and reached dispatch.
    const rec = recordingDispatcher();
    const result = await safeFetch("http://[::1]/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: rec.dispatcher,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("blocked_destination");
    }
    expect(rec.called()).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 loopback literal before dispatch", async () => {
    const rec = recordingDispatcher();
    const result = await safeFetch("http://[::ffff:127.0.0.1]/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: rec.dispatcher,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("blocked_destination");
    }
    expect(rec.called()).toBe(false);
  });

  it("rejects a public URL that redirects to a private IP literal", async () => {
    const agent = mockDispatcher();
    agent.get("http://a.test").intercept({ method: "GET", path: "/" }).reply(302, "", {
      headers: { location: "http://169.254.169.254/" },
    });
    const result = await safeFetch("http://a.test/", {
      timeoutMs: 2000,
      maxBytes: 1024,
      dispatcher: agent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("blocked_destination");
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout: a dispatcher that never responds must still time out under the
// single total deadline.
// ---------------------------------------------------------------------------

describe("safeFetch timeout", () => {
  it("times out when the server never responds", async () => {
    // A dispatcher that accepts the request but never replies, simulating a
    // hung server. The single total deadline must still fire.
    const hangingDispatcher: Dispatcher = {
      request() {
        return new Promise(() => {
          /* never resolves */
        });
      },
      // The Dispatcher interface requires a few members; stub them.
      dispatch() {
        return false;
      },
      close() {
        return Promise.resolve();
      },
      destroy() {
        return Promise.resolve();
      },
    } as unknown as Dispatcher;
    const start = Date.now();
    const result = await safeFetch("http://hang.test/", {
      timeoutMs: 300,
      maxBytes: 1024,
      dispatcher: hangingDispatcher,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// Secret leakage: a blocked or rejected fetch must never include query-string
// secrets (e.g. the SerpAPI key) in its result.
// ---------------------------------------------------------------------------

describe("secret leakage", () => {
  it("never includes a query-string API key in a blocked-fetch result code", async () => {
    // A SerpAPI-style URL carries the key in the query. When the fetch is
    // blocked (here by an unreachable host via a hanging dispatcher), the
    // result must encode only a policy code and never the secret.
    const SECRET = "AKIAFAKEKEY1234567890";
    const url = `https://serpapi.com/search?q=test&api_key=${SECRET}`;
    const hangingDispatcher: Dispatcher = {
      request() {
        return new Promise(() => {
          /* never resolves */
        });
      },
    } as unknown as Dispatcher;
    const result = await safeFetch(url, {
      timeoutMs: 200,
      maxBytes: 1024,
      dispatcher: hangingDispatcher,
    });
    expect(result.ok).toBe(false);
    // The entire result object must be free of the secret.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (!result.ok) {
      expect(result.code).toBe("timeout");
    }
  });

  it("never includes a query-string secret in a content-type rejection", async () => {
    const SECRET = "SUPERSECRETKEY";
    const agent = mockDispatcher();
    agent
      .get("https://serpapi.test")
      .intercept({ method: "GET", path: "/search" })
      .reply(200, "x", { headers: { "content-type": "text/plain" } });
    const result = await safeFetch(
      `https://serpapi.test/search?api_key=${SECRET}`,
      {
        timeoutMs: 2000,
        maxBytes: 1024,
        dispatcher: agent,
        allowContentType: (ct) => ct.includes("json"),
      },
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeWithContentType: charset-aware decoding
// ---------------------------------------------------------------------------

describe("decodeWithContentType", () => {
  it("decodes as UTF-8 when no charset is declared", () => {
    const text = "héllo wörld";
    const bytes = new TextEncoder().encode(text);
    expect(decodeWithContentType(bytes, "text/html")).toBe(text);
  });

  it("decodes as UTF-8 when charset=utf-8 is declared", () => {
    const text = "héllo";
    const bytes = new TextEncoder().encode(text);
    expect(decodeWithContentType(bytes, "text/html; charset=utf-8")).toBe(text);
  });

  it("decodes ISO-8859-1 when charset is declared", () => {
    // 0xe9 is é in ISO-8859-1
    const bytes = new Uint8Array([0x68, 0xe9, 0x6c, 0x6c, 0x6f]); // "héllo"
    expect(decodeWithContentType(bytes, "text/html; charset=iso-8859-1")).toBe("héllo");
  });

  it("decodes Windows-1252 when charset is declared", () => {
    // 0x92 is a curly apostrophe in Windows-1252
    const bytes = new Uint8Array([0x73, 0x92]); // s + right single quote
    const decoded = decodeWithContentType(bytes, "text/html; charset=windows-1252");
    expect(decoded).toBe("s\u2019");
  });

  it("falls back to UTF-8 for an unsupported charset", () => {
    const bytes = new Uint8Array([0x68, 0xe9, 0x6c, 0x6c, 0x6f]);
    // Non-existent charset — should fall back to UTF-8 without throwing.
    expect(() => decodeWithContentType(bytes, "text/html; charset=fake-charset")).not.toThrow();
    expect(decodeWithContentType(bytes, "text/html; charset=fake-charset")).toContain("h");
  });

  it("extracts charset from quoted values", () => {
    const bytes = new Uint8Array([0xe9]);
    expect(decodeWithContentType(bytes, 'text/html; charset="iso-8859-1"')).toBe("é");
  });
});
