// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import { convexTest } from "convex-test";

import schema from "../schema";
import { effectiveStatus, type MembershipStatus } from "./memberships";

// A minimal, typed spaceItems row. Built through a helper instead of `as any`
// so the compiler keeps the fixture honest as the schema evolves. The required
// fields mirror convex/schema.ts; only what effectiveStatus reads is needed.
function row(status?: MembershipStatus) {
  return {
    _id: "ks_spaceItems_abc" as never,
    _creationTime: 0,
    userId: "user-123",
    spaceId: "ks_spaces_s" as never,
    itemId: "ks_items_i" as never,
    status,
  };
}

describe("effectiveStatus", () => {
  it("returns each explicit status unchanged", () => {
    expect(effectiveStatus(row("suggested"))).toBe("suggested");
    expect(effectiveStatus(row("saved"))).toBe("saved");
    expect(effectiveStatus(row("dismissed"))).toBe("dismissed");
  });

  it("treats legacy status-less rows as saved", () => {
    expect(effectiveStatus(row(undefined))).toBe("saved");
  });
});

// Convex smoke test: loads the schema and module map and performs a database
// operation through the mocked backend — no live Convex deployment or
// credentials required. Verifies the test harness, schema, and module map can
// all resolve under @edge-runtime/vm.
const modules = import.meta.glob("../**/*.ts");

describe("convex-test harness", () => {
  it("reads a seeded space through the mock backend without credentials", async () => {
    const t = convexTest(schema, modules);
    const spaceId = await t.run(async (ctx) => {
      return await ctx.db.insert("spaces", {
        userId: "user-123",
        name: "Apartment shopping",
        dynamic: false,
      });
    });
    const fetched = await t.run(async (ctx) => {
      return await ctx.db.get(spaceId);
    });
    expect(fetched?.name).toBe("Apartment shopping");
  });
});
