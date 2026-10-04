import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The local-chain test talks to a node over RPC; give it room.
    testTimeout: 30_000,
  },
});
