import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
    exclude: [
      ...(process.env.SELFTEST ? [] : ["src/selftest/**"]),
      "**/node_modules/**",
    ],
  },
});
