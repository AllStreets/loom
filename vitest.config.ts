import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    exclude: [
      ...(process.env.SELFTEST ? [] : ["src/selftest/**"]),
      "**/node_modules/**",
      // Agent worktrees live under .claude/ — never part of this tree's suite.
      "**/.claude/**",
    ],
    server: {
      deps: {
        inline: ["three", "@react-three/fiber", "@react-three/postprocessing"],
      },
    },
  },
});
