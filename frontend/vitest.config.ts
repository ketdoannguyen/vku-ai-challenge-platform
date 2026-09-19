import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "worker/**/*.test.ts"],
    globals: true,
    testTimeout: 30000,
  },
});
