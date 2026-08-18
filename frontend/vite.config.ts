import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  // Vitest mounts client components in a Node process, so tests add the
  // "browser" condition to resolve the client build of Svelte. Production
  // must not set resolve.conditions at all: an empty list strips Vite's
  // default conditions and pulls Svelte's server build (node:async_hooks)
  // into the browser bundle.
  ...(mode === "test" ? { resolve: { conditions: ["browser"] } } : {}),
  server: {
    proxy: {
      // Allow `scripts/dev.sh --port` to redirect the dev proxy at a
      // non-default backend port. Defaults to 8080 for plain `vite`.
      "/api": process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8080"
    }
  }
}));
