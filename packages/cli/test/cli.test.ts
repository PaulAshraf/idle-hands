import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { text } from "node:stream/consumers";
import { agentIdFromPublicKey, verifyRequestSignature, readAuthHeaders } from "@idle-hands/protocol/crypto";
import { DEFAULT_SERVER_URL, buildInstance, verifyPayload } from "@idle-hands/protocol";
import { parse } from "../src/args.ts";
import { serverUrl } from "../src/profile.ts";
const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const run = promisify(execFile);

test("strict options, arity and profile selection", () => {
  assert.equal(parse(["--profile", "two", "goals", "--json"]).opt("profile"), "two");
  for (const args of [["wat"], ["goal"], ["goals", "--force"], ["best", "g", "-o"], ["goal", "g", "extra"]])
    assert.throws(() => parse(args), { code: "usage" });
});

test("explicit server, environment, saved server, production precedence", (t) => {
  const original = process.env.IH_SERVER;
  t.after(() => {
    if (original === undefined) delete process.env.IH_SERVER;
    else process.env.IH_SERVER = original;
  });
  delete process.env.IH_SERVER;
  assert.equal(serverUrl(), DEFAULT_SERVER_URL);
  assert.equal(serverUrl(undefined, "http://saved"), "http://saved");
  process.env.IH_SERVER = "http://env";
  assert.equal(serverUrl(undefined, "http://saved"), "http://env");
  assert.equal(serverUrl("http://explicit", "http://saved"), "http://explicit");
});

test("signed CLI workflow", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ih-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const params = { n: 8, seed: "cli" };
  let key = "",
    bestScore: number | null = null,
    posts = 0;
  const nonces = new Set<string>();
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    const body = raw ? JSON.parse(raw) : {};
    function send(status: number, obj: unknown) {
      res.writeHead(status, { "Content-Type": "application/json", "Retry-After": "0" });
      res.end(JSON.stringify(obj));
    }
    const url = req.url!;
    try {
      if (req.method === "POST" || url === "/api/me") {
        const auth = readAuthHeaders(req.headers);
        assert.ok(auth);
        const publicKey = url === "/api/agents" ? body.publicKey : key;
        assert.equal(auth.agentId, await agentIdFromPublicKey(publicKey));
        assert.ok(!nonces.has(auth.nonce));
        nonces.add(auth.nonce);
        assert.ok(
          (await verifyRequestSignature({ auth, publicKey, body: raw, path: url, method: req.method! })).ok,
        );
        assert.ok(!("privateKey" in body));
      }
      if (url === "/api/agents") {
        if (body.handle === "taken")
          return send(409, { error: { code: "handle_taken", message: "Handle in use." } });
        key = body.publicKey;
        return send(201, { agent: body, created: true });
      }
      if (url === "/api/me") return send(200, { agent: { publicKey: key } });
      if (url === "/api/goals") return send(200, { goals: [{ id: "tsp", status: "open", verifier: "tsp" }] });
      if (url === "/api/goals/tsp/best") return send(200, { submission: null });
      if (url === "/api/goals/tsp/claims") return send(201, { claim: { id: "clm_test", title: body.title } });
      if (url?.startsWith("/api/claims/clm_test/")) return send(200, { claim: { id: "clm_test", ...body } });
      if (url === "/api/goals/tsp/messages") return send(201, { message: { id: "msg_test", ...body } });
      if (url === "/api/goals/tsp")
        return send(200, { goal: { verifier: "tsp", params, bestScore, objective: "minimize" } });
      if (url === "/api/goals/tsp/submissions") {
        if (++posts === 1) return send(429, { error: { code: "rate_limited", message: "Wait." } });
        const result = verifyPayload("tsp", params, body.payload);
        return send(201, {
          submission: result.ok
            ? { score: result.score, status: "accepted", isBest: true }
            : { status: "rejected", error: result.error },
          rank: result.ok ? 1 : null,
          previousBest: null,
        });
      }
      send(404, { error: { code: "not_found", message: "No route" } });
    } catch (e) {
      send(500, { error: { code: "test_error", message: String(e) } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = {
    ...process.env,
    IH_HOME: cwd,
    IH_PROFILE: "test",
    IH_SERVER: "http://127.0.0.1:" + address.port,
  };
  const identity = join(cwd, "profiles/test/identity.json");
  async function cli(code: number, ...args: string[]) {
    try {
      const result = await run(process.execPath, [path("../src/index.ts"), ...args, "--json"], { cwd, env });
      assert.equal(code, 0);
      assert.equal(result.stderr, "");
      return JSON.parse(result.stdout);
    } catch (e) {
      const err = e as { code: number; stdout: string; stderr: string };
      assert.equal(err.code, code, err.stderr);
      assert.equal(err.stdout, "");
      return JSON.parse(err.stderr);
    }
  }
  await t.test("usage error is JSON on stderr", async () => {
    assert.equal((await cli(2, "verify")).error.code, "usage");
  });
  await t.test(
    "profile permissions, retry after handle collision, update without rotating, signed whoami",
    async () => {
      assert.match(
        (await cli(1, "init", "--handle", "taken", "--kind", "demo")).error.message,
        /another --handle/,
      );
      const original = JSON.parse(await readFile(identity, "utf8"));
      assert.equal((await stat(identity)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(identity))).mode & 0o777, 0o700);
      await cli(0, "init", "--handle", "test-agent", "--kind", "demo");
      assert.equal(key, original.publicKey);
      const who = await cli(0, "whoami");
      assert.equal(who.local.handle, "test-agent");
      assert.ok(who.local.keyFingerprint);
      assert.ok(!JSON.stringify(who).includes(original.privateKey));
    },
  );
  await t.test("instance fallback builds and caches the shared instance", async () => {
    assert.equal((await cli(0, "instance", "tsp", "-o", "instance.json")).source, "local");
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, "instance.json"), "utf8")),
      buildInstance("tsp", params),
    );
    assert.equal((await cli(0, "instance", "tsp", "-o", "instance.json")).source, "cache");
  });
  await t.test("local rejection, skip, one 429 retry and server rejection", async () => {
    await writeFile(join(cwd, "bad"), "{}");
    assert.equal((await cli(3, "submit", "tsp", "bad")).error.code, "verifier_rejected");
    await writeFile(join(cwd, "good"), JSON.stringify({ tour: Array.from({ length: 8 }, (_, i) => i) }));
    bestScore = 0;
    assert.equal((await cli(0, "submit", "tsp", "good", "--only-if-better")).skipped, true);
    assert.equal(posts, 0);
    bestScore = null;
    assert.equal((await cli(0, "submit", "tsp", "good")).submission.status, "accepted");
    assert.equal(posts, 2);
    assert.equal((await cli(3, "submit", "tsp", "bad", "--no-verify")).submission.status, "rejected");
  });
  await t.test("claim, heartbeat, post and release send protocol fields", async () => {
    assert.equal(
      (await cli(0, "claim", "tsp", "Nearest neighbour", "--plan", "Restart")).claim.id,
      "clm_test",
    );
    assert.equal(
      (await cli(0, "heartbeat", "clm_test", "--progress", "Searching")).claim.progress,
      "Searching",
    );
    assert.equal(
      (await cli(0, "post", "tsp", "--kind", "finding", "--reply-to", "msg_first", "Found a shorter tour"))
        .message.replyTo,
      "msg_first",
    );
    assert.equal(
      (await cli(0, "release", "clm_test", "--outcome", "succeeded", "--summary", "Done")).claim.outcome,
      "succeeded",
    );
  });
  await t.test("demo bot completes a bounded local run", async () => {
    const before = posts;
    const { stdout } = await run(
      process.execPath,
      [path("../scripts/demo-swarm.ts"), "--server", env.IH_SERVER, "--agents", "1", "--minutes", "0.035"],
      { cwd, env, timeout: 15000 },
    );
    assert.match(stdout, /demo-bot-1-.* reached /);
    assert.equal(posts, before + 1);
  });
});
for (const [verifier, solver, params] of [
  ["tsp", "tsp-2opt", { n: 200, seed: "idle-hands-1" }],
  ["graph-coloring", "coloring-dsatur", { n: 300, p: 0.3, seed: "idle-hands-3" }],
] as const)
  test(solver + " produces verified candidates and preserves an incumbent", async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ih-example-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, "instance.json"), JSON.stringify(buildInstance(verifier, params)));
    let score = Infinity;
    for (let i = 0; i < 2; i++) {
      await run(process.execPath, [path("../examples/" + solver + ".mjs"), "--seconds", "0.15"], { cwd });
      const raw = await readFile(join(cwd, "payload.json"), "utf8");
      const result = verifyPayload(verifier, params, JSON.parse(raw));
      assert.ok(result.ok);
      assert.ok(result.score <= score);
      score = result.score;
      await writeFile(join(cwd, "best.json"), raw);
    }
  });
