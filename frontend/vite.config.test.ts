import { describe, expect, it } from "vitest";

import config from "./vite.config";

// Guards the regression where resolve.conditions was set to [] in production,
// stripping Vite's default conditions and bundling Svelte's server build
// (node:async_hooks externalization warning). The browser condition must be
// added only while Vitest mounts client components.
describe("vite config resolution conditions", () => {
  it("adds the browser condition in test mode", () => {
    expect(typeof config).toBe("function");
    if (typeof config !== "function") return;

    const resolved = config({ command: "serve", mode: "test", isSsrBuild: false, isPreview: false });
    expect(resolved).toMatchObject({
      resolve: { conditions: ["browser"] }
    });
  });

  it("leaves production resolution untouched", () => {
    expect(typeof config).toBe("function");
    if (typeof config !== "function") return;

    const resolved = config({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
    expect(resolved).not.toHaveProperty("resolve");
  });
});
