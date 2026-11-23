import { fileURLToPath, URL } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      // The final vitest-pool-workers release bundles the August 2026 runtime.
      compatibilityDate: "2026-08-15",
      bindings: { TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))) },
    },
  }))],
});
