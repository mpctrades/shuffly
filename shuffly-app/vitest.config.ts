import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Deliberately separate from vite.config.ts: the reactRouter() plugin there
// expects a full app build context (route manifest, etc.) that unit tests
// for plain/.server.ts logic don't need and shouldn't have to satisfy.
// tsconfigPaths() alone is enough to resolve the app's path aliases.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
