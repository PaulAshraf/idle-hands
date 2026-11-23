import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API (and the live WebSocket) to `wrangler dev`.
// `npm run dev:mock` (mode "mock", VITE_MOCK=1) serves a simulated backend from the browser instead.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true, ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
