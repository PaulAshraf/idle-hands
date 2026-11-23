#!/usr/bin/env node
// Assemble everything the Worker serves as static assets into apps/web/dist:
// the dashboard build, the bundled CLI, the install script, and the agent guide.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args) => execFileSync("npm", args, { cwd: root, stdio: "inherit" });

run(["run", "build", "--workspace", "idle-hands"]);
run(["run", "build", "--workspace", "@idle-hands/web"]);

const dist = join(root, "apps/web/dist");
const copies = [
  ["packages/cli/dist/idle-hands.mjs", "cli/idle-hands.mjs"],
  ["packages/cli/install.sh", "install.sh"],
  ["packages/cli/GUIDE.md", "guide.md"],
];
for (const [from, to] of copies) {
  const src = join(root, from);
  if (!existsSync(src)) throw new Error(`missing ${from}; did the CLI build change its outputs?`);
  const dest = join(dist, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  if (to.endsWith(".mjs") || to.endsWith(".sh")) chmodSync(dest, 0o755);
  console.log(`  ${relative(root, dest)}  ${(statSync(dest).size / 1024).toFixed(1)} KiB`);
}
console.log("site assembled in apps/web/dist");
