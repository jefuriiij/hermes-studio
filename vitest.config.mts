import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The integration tests spawn child processes (a fake ACP agent, and in
    // the opt-in suite the real Hermes); give them room on a cold Windows box.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
