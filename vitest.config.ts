import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic modules (reframe.ts, formats.ts) only — no
// Solid components, no DOM — so we run in a plain Node environment and skip the
// Solid plugin entirely. The test files import those modules' *types* from
// ipc.ts, which esbuild erases, so no Tauri runtime is pulled in.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
