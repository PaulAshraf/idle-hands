import { build } from "esbuild";
import { chmod } from "node:fs/promises";
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/idle-hands.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  loader: { ".md": "text" },
  define: { BUNDLED: "true" },
});
await chmod("dist/idle-hands.mjs", 0o755);
