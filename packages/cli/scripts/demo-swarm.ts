import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { GoalsResponse, ClaimResponse } from "@idle-hands/protocol";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    agents: { type: "string", default: "2" },
    minutes: { type: "string", default: "1" },
  },
});
const n = Number(values.agents),
  minutes = Number(values.minutes);
if (!values.server || !Number.isSafeInteger(n) || n < 1 || !Number.isFinite(minutes) || minutes <= 0)
  throw Error("Use --server URL --agents POSITIVE_INTEGER --minutes POSITIVE_NUMBER");
const server = values.server;
const run = promisify(execFile);
const script = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const root = await mkdtemp(join(tmpdir(), "idle-hands-demo-"));
const deadline = Date.now() + minutes * 60000;
const suffix = randomBytes(4).toString("hex");
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function bot(i: number) {
  const profile = "demo-bot-" + i + "-" + suffix;
  const cwd = join(root, profile);
  await mkdir(cwd);
  const env = { ...process.env, IH_HOME: root, IH_PROFILE: profile, IH_SERVER: server };
  async function cli<T>(...args: string[]): Promise<T> {
    const { stdout } = await run(process.execPath, [script("../src/index.ts"), ...args, "--json"], {
      cwd,
      env,
    });
    return JSON.parse(stdout);
  }
  await cli("init", "--kind", "demo", "--handle", profile);
  const { goals } = await cli<GoalsResponse>("goals");
  const open = goals.filter((g) => g.status === "open" && ["tsp", "graph-coloring"].includes(g.verifier));
  if (!open.length) throw Error("No open goal with an example solver");
  for (let round = 0; !stopping && Date.now() < deadline; round++) {
    const goal = open[(round + i) % open.length]!;
    const solver = goal.verifier === "tsp" ? "tsp-2opt" : "coloring-dsatur";
    const { claim } = await cli<ClaimResponse>("claim", goal.id, solver + " randomized restart " + i);
    let summary = "Experiment interrupted";
    let outcome = "failed";
    try {
      await cli("instance", goal.id, "-o", "instance.json");
      await rm(join(cwd, "best.json"), { force: true });
      const best = await cli<{ parent?: string }>("best", goal.id, "-o", "best.json");
      await run(
        process.execPath,
        [
          script("../examples/" + solver + ".mjs"),
          "--seconds",
          String(Math.max(0, Math.min(4, (deadline - Date.now()) / 1000))),
        ],
        { cwd },
      );
      await cli("heartbeat", claim.id, "--progress", "Solver finished. Checking candidate.");
      const result = await cli<{ skipped?: boolean; submission?: { score: number } }>(
        "submit",
        goal.id,
        "payload.json",
        "--claim",
        claim.id,
        "--only-if-better",
        ...(best.parent ? ["--parent", best.parent] : []),
      );
      summary = result.skipped
        ? solver + " did not improve the incumbent."
        : solver + " reached " + result.submission?.score + ".";
      console.log(profile, goal.id, summary);
      if (!result.skipped && round % 3 === 0) await cli("post", goal.id, "--kind", "finding", summary);
      outcome = result.skipped ? "failed" : "succeeded";
    } finally {
      await cli("release", claim.id, "--outcome", outcome, "--summary", summary);
    }
    await delay(Math.max(0, Math.min(2500, deadline - Date.now())));
  }
}
try {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => bot(i + 1)));
  for (const result of results)
    if (result.status === "rejected") {
      console.error(result.reason.message);
      process.exitCode = 1;
    }
} finally {
  await rm(root, { recursive: true, force: true });
}
