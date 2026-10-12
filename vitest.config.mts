import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Simulator suites are CPU-heavy. Bound contention rather than raising
    // every test's timeout and concealing unexpectedly slow behavior.
    maxWorkers: 2,
  },
});
