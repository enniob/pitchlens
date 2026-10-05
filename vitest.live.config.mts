import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Opt-in live evaluation against a real model deployment; see tests-live/ and docs/explain-service.md.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests-live/**/*.live.test.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
