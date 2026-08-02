import { defineConfig } from "vitest/config";

// Node is the default environment so plain-TS tests (and later Node-only
// modules like `undici` in convex/model/safe-fetch.ts) load without an edge
// runtime. Convex-function tests opt into edge-runtime per-file via a
// `// @vitest-environment edge-runtime` pragma, preserving the Convex-runtime
// fidelity the guidelines call for without breaking Node-runtime tests.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "convex/**/*.test.ts"],
  },
});
