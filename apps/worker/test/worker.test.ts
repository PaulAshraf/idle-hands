import { env } from "cloudflare:workers";
import {
  SELF, applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext,
  type D1Migration,
} from "cloudflare:test";
import {
  LIMITS, type AgentResponse, type AgentsResponse, type ApiError, type BestResponse,
  type ClaimResponse, type ClaimsResponse, type FeedResponse, type GoalResponse, type GoalsResponse,
  type HistoryResponse, type LeaderboardResponse, type LiveFrame, type MeResponse, type MessageResponse,
  type MessagesResponse, type RegisterResponse, type StatsResponse, type SubmissionResponse,
  type SubmissionsResponse, type SubmitResponse,
} from "@idle-hands/protocol";
import { generateAgentKeys, signRequest, type AgentKeys } from "@idle-hands/protocol/crypto";
import { buildInstance, type TspInstance } from "@idle-hands/protocol/verifiers";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import worker from "../src/index.ts";
import type { WorkerBindings } from "../src/http.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const base = "https://idle-hands.test";
const goal = "/api/goals/tsp-200";
const otherGoal = "/api/goals/tsp-1000";
const tour = Array.from({ length: 200 }, (_, index) => index);
const candidate = { payload: { tour } };
const { cities } = buildInstance("tsp", { n: 200, seed: "idle-hands-1" }) as TspInstance;
const shorterTour = [0];
const unvisited = new Set(tour.slice(1));
while (unvisited.size > 0) {
  const [x, y] = cities[shorterTour.at(-1)!]!;
  let nearest = -1;
  let distance = Infinity;
  for (const index of unvisited) {
    const [cx, cy] = cities[index]!;
    const squared = (cx - x) ** 2 + (cy - y) ** 2;
    if (squared < distance) {
      nearest = index;
      distance = squared;
    }
  }
  shorterTour.push(nearest);
  unvisited.delete(nearest);
}
const shorterCandidate = { payload: { tour: shorterTour } };

function get(path: string) {
  return SELF.fetch(base + path);
}

function json<T>(response: Response): Promise<T> {
  return response.json<T>();
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(await json<ApiError>(response)).toEqual({ error: { code, message: expect.any(String) } });
}

async function signed(
  keys: AgentKeys, path: string, data?: unknown, options: { now?: number; ip?: string } = {},
) {
  const method = data === undefined ? "GET" : "POST";
  const body = data === undefined ? undefined : JSON.stringify(data);
  const headers = await signRequest({ keys, method, path, body, now: options.now });
  if (options.ip) headers["CF-Connecting-IP"] = options.ip;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return SELF.fetch(base + path, { method, body, headers });
}

async function agent(handle: string) {
  const keys = await generateAgentKeys();
  const res = await signed(keys, "/api/agents", { publicKey: keys.publicKey, handle, kind: "codex" });
  expect(res.status).toBe(201);
  return keys;
}

async function submit(keys: AgentKeys, body: unknown = candidate, path = goal) {
  const response = await signed(keys, path + "/submissions", body);
  expect(response.status).toBe(201);
  return json<SubmitResponse>(response);
}

async function claim(keys: AgentKeys, title = "Two-opt experiment") {
  const response = await signed(keys, goal + "/claims", { title });
  expect(response.status).toBe(201);
  return (await json<ClaimResponse>(response)).claim;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE goals SET best_score = NULL, best_submission_id = NULL, best_agent_id = NULL, best_at = NULL, status = 'open'"),
    ...["events", "submissions", "claims", "messages", "agents", "nonces", "registration_attempts"]
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  ]);
});

describe("discovery and HTTP behavior", () => {
  test("serves health, goal metadata, the deterministic instance and an empty best", async () => {
    const health = await get("/api/health");
    expect(health.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await health.json()).toMatchObject({ ok: true, version: "0.1.0" });
    const goals = await json<GoalsResponse>(await get("/api/goals"));
    expect(goals.goals.map(({ id }) => id)).toEqual(["color-300", "tsp-1000", "tsp-200"]);
    const next = await json<GoalsResponse>(await get("/api/goals?limit=1&before=color-300"));
    expect(next.goals.map(({ id }) => id)).toEqual(["tsp-1000"]);
    const { goal: detail } = await json<GoalResponse>(await get(goal));
    expect(detail.params).toEqual({ n: 200, seed: "idle-hands-1" });
    expect(detail.description).toContain("idle-hands best tsp-200");
    expect(detail.description).toContain(detail.payloadHelp);
    expect(detail.bestScore).toBeNull();
    const instance = await get(goal + "/instance");
    expect(instance.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(await instance.json()).toEqual(buildInstance("tsp", detail.params));
    expect(await json<BestResponse>(await get(goal + "/best"))).toEqual({ submission: null });
  });

  test("answers preflight and returns JSON errors for unknown API paths", async () => {
    const options = await SELF.fetch(base + goal + "/submissions", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(options.headers.get("Access-Control-Allow-Headers")).toContain("x-ih-signature");
    const unknown = await get("/api/unknown/deep");
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expectError(unknown, 404, "not_found");
    await expectError(await get("/api"), 404, "not_found");
    await expectError(await get("/api/goals/missing/instance"), 404, "not_found");
  });

  test("rejects over-limit Content-Length and streaming body bytes", async () => {
    const path = "/api/agents";
    const declared = new Request(base + path, {
      method: "POST", headers: { "Content-Length": String(LIMITS.maxBodyBytes + 1) },
    });
    await expectError(await worker.fetch(declared, env, createExecutionContext()), 413, "payload_too_large");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LIMITS.maxBodyBytes));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const streamed = new Request(base + path, { method: "POST", body: stream });
    expect(streamed.headers.has("Content-Length")).toBe(false);
    await expectError(await worker.fetch(streamed, env, createExecutionContext()), 413, "payload_too_large");
  });
});

describe("registration and signing", () => {
  test("registers and updates a profile, emitting only the first registration event", async () => {
    const keys = await agent("starter");
    const updated = await signed(keys, "/api/agents", {
      publicKey: keys.publicKey, handle: "renamed", kind: "claude-code", model: "model", operator: "operator",
    });
    expect(updated.status).toBe(200);
    expect(await json<RegisterResponse>(updated)).toMatchObject({
      created: false, agent: { id: keys.agentId, handle: "renamed", kind: "claude-code", model: "model", operator: "operator" },
    });
    const { agent: profile } = await json<MeResponse>(await signed(keys, "/api/me"));
    expect(profile.publicKey).toBe(keys.publicKey);
    expect(profile.stats).toEqual({ submissions: 0, accepted: 0, improvements: 0, bestsHeld: 0, messages: 0, claims: 0, goals: 0 });
    expect((await json<AgentResponse>(await get("/api/agents/renamed"))).agent).toEqual(profile);
    expect((await json<AgentResponse>(await get("/api/agents/" + keys.agentId))).agent).toEqual(profile);
    await expectError(await get("/api/agents/starter"), 404, "not_found");
    const feed = await json<FeedResponse>(await get("/api/feed"));
    expect(feed.events).toMatchObject([{ type: "agent.registered", data: { handle: "starter" } }]);
  });

  test("rejects a taken handle on registration or profile update", async () => {
    await agent("reserved");
    const fresh = await generateAgentKeys();
    const existing = await agent("existing");
    for (const keys of [fresh, existing]) {
      await expectError(await signed(keys, "/api/agents", {
        publicKey: keys.publicKey, handle: "reserved", kind: "codex",
      }), 409, "handle_taken");
    }
    expect((await json<MeResponse>(await signed(existing, "/api/me"))).agent.handle).toBe("existing");
  });

  test("rejects a registration whose signed identity and public key disagree", async () => {
    const [keys, stranger] = await Promise.all([generateAgentKeys(), generateAgentKeys()]);
    await expectError(await signed(keys, "/api/agents", {
      publicKey: stranger.publicKey, handle: "imposter", kind: "codex",
    }), 401, "bad_signature");
  });

  test("rejects missing and malformed authentication headers", async () => {
    await expectError(await get("/api/me"), 401, "unauthenticated");
    const keys = await agent("auth-headers");
    const headers = await signRequest({ keys, method: "GET", path: "/api/me" });
    headers["x-ih-nonce"] = "abc";
    await expectError(await SELF.fetch(base + "/api/me", { headers }), 401, "bad_auth_headers");
  });

  test("rejects unknown agents before checking clock skew, and rejects skew for registered agents", async () => {
    const now = Date.now() - 2 * LIMITS.clockSkewMs;
    await expectError(await signed(await generateAgentKeys(), "/api/me", undefined, { now }), 401, "unknown_agent");
    await expectError(await signed(await agent("clock"), "/api/me", undefined, { now }), 401, "clock_skew");
  });

  test("signs the raw bytes and the exact path plus query before parsing JSON", async () => {
    const keys = await agent("raw-bytes");
    const path = goal + "/messages?one=%20&two=z";
    const body = '{ "kind" : "finding", "body" : "space ✓" }\n';
    const headers = await signRequest({ keys, method: "POST", path, body });
    const send = (urlPath: string, body: string) => SELF.fetch(base + urlPath, { method: "POST", headers, body });
    await expectError(await send(path, "malformed JSON"), 401, "bad_signature");
    await expectError(await send(goal + "/messages?two=z&one=%20", body), 401, "bad_signature");
    const res = await send(path, body);
    expect(res.status).toBe(201);
    expect((await json<MessageResponse>(res)).message.body).toBe("space ✓");
    await expectError(await send(path, body), 401, "replayed_nonce");
  });

  test("allows only one concurrent request with the same nonce", async () => {
    const keys = await agent("concurrent-replay");
    const headers = await signRequest({ keys, method: "GET", path: "/api/me" });
    const responses = await Promise.all([0, 1].map(() => SELF.fetch(base + "/api/me", { headers })));
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 401]);
    await expectError(responses.find(({ status }) => status === 401)!, 401, "replayed_nonce");
  });

  test("validates schema fields after verification", async () => {
    const keys = await agent("schema");
    const res = await signed(keys, goal + "/claims", { title: "X" });
    expect(res.status).toBe(400);
    expect((await json<ApiError>(res)).error).toMatchObject({ code: "bad_request", message: expect.stringContaining("title") });
    await expectError(await signed(keys, goal + "/submissions", {}), 400, "bad_request");
  });
});

describe("submissions and standings", () => {
  test("stores accepted and rejected payloads and emits submission and improvement events", async () => {
    const keys = await agent("solver");
    const best = await submit(keys);
    expect(best).toMatchObject({
      submission: { status: "accepted", isBest: true, error: null }, rank: 1, previousBest: null,
    });
    const invalid = await submit(keys, { payload: { tour: [] }, parentId: best.submission.id });
    expect(invalid).toMatchObject({
      submission: { status: "rejected", isBest: false, score: null, error: expect.any(String) },
      rank: null, previousBest: best.submission.score,
    });
    const listing = await json<SubmissionsResponse>(await get(goal + "/submissions?status=rejected&agentId=" + keys.agentId));
    expect(listing.submissions).toEqual([invalid.submission]);
    const older = await json<SubmissionsResponse>(await get(goal + "/submissions?before=" + invalid.submission.id));
    expect(older.submissions).toEqual([best.submission]);
    const detail = await json<SubmissionResponse>(await get("/api/submissions/" + invalid.submission.id));
    expect(detail.submission.payload).toEqual({ tour: [] });
    const current = await json<BestResponse>(await get(goal + "/best"));
    expect(current.submission).toEqual({ ...best.submission, payload: candidate.payload });
    const feed = await json<FeedResponse>(await get("/api/feed?goalId=tsp-200"));
    expect(feed.events).toMatchObject([
      { type: "submission.created", data: best.submission },
      { type: "goal.improved", data: { score: best.submission.score, previousScore: null, submissionId: best.submission.id } },
      { type: "submission.created", data: invalid.submission },
    ]);
    expect(feed.events[0]?.data).not.toHaveProperty("payload");
  });

  test("preserves first credit for a tie, reports score rank, and orders leaderboard and history", async () => {
    const first = await agent("first");
    const second = await agent("second");
    const third = await agent("third");
    const initial = await submit(first);
    const tie = await submit(second);
    expect(tie).toMatchObject({ submission: { isBest: false }, rank: 1, previousBest: initial.submission.score });
    const win = await submit(third, { ...shorterCandidate, parentId: initial.submission.id });
    expect(win).toMatchObject({ submission: { isBest: true }, rank: 1, previousBest: initial.submission.score });
    const worse = await submit(third);
    expect(worse).toMatchObject({ submission: { isBest: false }, rank: 2, previousBest: win.submission.score });

    const standings = await json<LeaderboardResponse>(await get(goal + "/leaderboard"));
    expect(standings.entries).toMatchObject([
      { rank: 1, agentHandle: "third", bestSubmissionId: win.submission.id, improvements: 1, accepted: 2, attempts: 2 },
      { rank: 2, agentHandle: "first", bestSubmissionId: initial.submission.id, improvements: 1 },
      { rank: 3, agentHandle: "second", bestSubmissionId: tie.submission.id, improvements: 0 },
    ]);
    const older = await json<LeaderboardResponse>(await get(goal + "/leaderboard?limit=1&before=" + win.submission.id));
    expect(older.entries.map(({ rank }) => rank)).toEqual([2]);
    const history = await json<HistoryResponse>(await get(goal + "/history"));
    expect(history.points.map(({ submissionId }) => submissionId)).toEqual([initial.submission.id, win.submission.id]);
    const stats = await json<StatsResponse>(await get("/api/stats"));
    expect(stats.stats).toMatchObject({ goals: 3, agents: 3, activeAgents24h: 3, submissions: 4, acceptedSubmissions: 4, improvements: 2 });
    const agents = await json<AgentsResponse>(await get("/api/agents?sort=improvements&limit=2"));
    expect(agents.agents.map(({ stats }) => stats.improvements)).toEqual([1, 1]);
    const profile = await json<AgentResponse>(await get("/api/agents/third"));
    expect(profile.agent.stats).toMatchObject({ submissions: 2, accepted: 2, bestsHeld: 1, goals: 1 });
    expect(profile.recentSubmissions.map(({ id }) => id)).toEqual([worse.submission.id, win.submission.id]);
  });

  test("serializes simultaneous competing bests and ties", async () => {
    const first = await agent("racer-one");
    const second = await agent("racer-two");
    const writes = await Promise.all([submit(first, shorterCandidate), submit(second, shorterCandidate)]);
    const winners = writes.filter(({ submission }) => submission.isBest);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.previousBest).toBeNull();
    expect(writes.find(({ submission }) => !submission.isBest)?.previousBest).toBe(winners[0]?.submission.score);
    const current = await json<BestResponse>(await get(goal + "/best"));
    expect(current.submission?.id).toBe(winners[0]?.submission.id);
    const history = await json<HistoryResponse>(await get(goal + "/history"));
    expect(history.points).toHaveLength(1);
    const leaderboard = await json<LeaderboardResponse>(await get(goal + "/leaderboard"));
    expect(leaderboard.entries[0]?.bestSubmissionId).toBe(winners[0]?.submission.id);
  });

  test("validates claim ownership, same-goal parents and open status", async () => {
    const owner = await agent("claim-owner");
    const visitor = await agent("visitor");
    const owned = await claim(owner);
    await expectError(await signed(visitor, goal + "/submissions", { ...candidate, claimId: owned.id }), 403, "forbidden");
    await expectError(await signed(owner, otherGoal + "/submissions", { ...candidate, claimId: owned.id }), 400, "bad_request");
    await expectError(await signed(owner, goal + "/submissions", { ...candidate, parentId: "missing" }), 400, "bad_request");
    const result = await submit(owner, { ...candidate, claimId: owned.id });
    expect(result.submission.claimId).toBe(owned.id);
    await env.DB.prepare("UPDATE goals SET status = 'closed' WHERE id = 'tsp-200'").run();
    await expectError(await signed(owner, goal + "/submissions", candidate), 409, "goal_closed");
  });
});

describe("claims and messages", () => {
  test("caps active claims, enforces ownership, extends leases and releases a claim", async () => {
    const owner = await agent("claimer");
    const stranger = await agent("stranger");
    const attempts = await Promise.all(Array.from({ length: LIMITS.maxActiveClaimsPerAgentPerGoal + 1 }, (_, index) =>
      signed(owner, goal + "/claims", { title: "Approach " + index, plan: "Try a local search" })));
    const allowed = attempts.filter(({ status }) => status === 201);
    expect(allowed).toHaveLength(LIMITS.maxActiveClaimsPerAgentPerGoal);
    await expectError(attempts.find(({ status }) => status === 409)!, 409, "too_many_claims");
    const { claim: first } = await json<ClaimResponse>(allowed[0]!);
    const path = "/api/claims/" + first.id;
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(LIMITS.claimLeaseMs);
    await expectError(await signed(stranger, path + "/heartbeat", {}), 403, "forbidden");
    await expectError(await signed(stranger, path + "/release", { outcome: "abandoned" }), 403, "forbidden");
    const heartbeat = await signed(owner, path + "/heartbeat", { progress: "Found a shorter tour" });
    expect(heartbeat.status).toBe(200);
    const heartbeatClaim = (await json<ClaimResponse>(heartbeat)).claim;
    expect(heartbeatClaim).toMatchObject({ id: first.id, status: "active", progress: "Found a shorter tour" });
    expect(Date.parse(heartbeatClaim.expiresAt) - Date.parse(heartbeatClaim.heartbeatAt)).toBe(LIMITS.claimLeaseMs);
    const released = await signed(owner, path + "/release", { outcome: "succeeded", summary: "2-opt worked" });
    expect(released.status).toBe(200);
    expect((await json<ClaimResponse>(released)).claim).toMatchObject({
      status: "succeeded", summary: "2-opt worked", endedAt: expect.any(String),
    });
    await expectError(await signed(owner, path + "/heartbeat", {}), 409, "claim_not_active");
    const active = await json<ClaimsResponse>(await get(goal + "/claims"));
    expect(active.claims.map(({ id }) => id)).not.toContain(first.id);
    const all = await json<ClaimsResponse>(await get(goal + "/claims?active=0"));
    expect(all.claims.find(({ id }) => id === first.id)?.status).toBe("succeeded");
    expect((await claim(owner, "Next experiment")).status).toBe("active");
  });

  test("reads claims as expired immediately and sweeps them and old nonces exactly once", async () => {
    const owner = await agent("expiring");
    const created = await claim(owner);
    await env.DB.batch([
      env.DB.prepare("UPDATE claims SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), created.id),
      env.DB.prepare("INSERT INTO nonces VALUES (?, ?, ?)").bind(owner.agentId, "obsolete-nonce-value", Date.now() - LIMITS.nonceTtlMs - 1000),
    ]);
    const path = "/api/claims/" + created.id;
    await expectError(await signed(owner, path + "/heartbeat", {}), 409, "claim_not_active");
    await expectError(await signed(owner, path + "/release", { outcome: "abandoned" }), 409, "claim_not_active");
    expect((await json<ClaimsResponse>(await get(goal + "/claims?active=0"))).claims[0]?.status).toBe("expired");
    expect((await json<ClaimsResponse>(await get(goal + "/claims"))).claims).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM claims WHERE id = ?").bind(created.id).first("status")).toBe("active");
    for (let sweep = 0; sweep < 2; sweep++) {
      const ctx = createExecutionContext();
      worker.scheduled(createScheduledController(), env, ctx);
      await waitOnExecutionContext(ctx);
    }
    expect(await env.DB.prepare("SELECT status FROM claims WHERE id = ?").bind(created.id).first("status")).toBe("expired");
    expect(await env.DB.prepare("SELECT nonce FROM nonces WHERE nonce = 'obsolete-nonce-value'").first()).toBeNull();
    const { events } = await json<FeedResponse>(await get("/api/feed?goalId=tsp-200"));
    expect(events.map(({ type }) => type)).toEqual(["claim.created", "claim.updated"]);
    expect(events[1]?.data).toMatchObject({ id: created.id, status: "expired" });
  });

  test("posts messages, filters by kind, and rejects missing and cross-goal replies", async () => {
    const writer = await agent("writer");
    const finding = await signed(writer, goal + "/messages", { kind: "finding", body: "**2-opt** improved the tour" });
    expect(finding.status).toBe(201);
    const { message } = await json<MessageResponse>(finding);
    const reply = await signed(writer, goal + "/messages", { kind: "question", body: "How far?", replyTo: message.id });
    expect(reply.status).toBe(201);
    const replyId = (await json<MessageResponse>(reply)).message.id;
    for (const [path, replyTo] of [[goal, "missing"], [otherGoal, message.id]] as const) {
      await expectError(await signed(writer, path + "/messages", { kind: "status", body: "Invalid", replyTo }), 400, "bad_request");
    }
    expect((await json<MessagesResponse>(await get(goal + "/messages?kind=finding"))).messages).toEqual([message]);
    expect((await json<MessagesResponse>(await get(goal + "/messages?before=" + replyId))).messages).toEqual([message]);
  });
});

describe("rate limits", () => {
  test("limits messages per agent across goals and supplies Retry-After", async () => {
    const writer = await agent("limited-writer");
    const data = { kind: "status", body: "Experiment in progress" };
    const responses = await Promise.all(Array.from({ length: LIMITS.messagesPerMinute + 1 }, (_, index) =>
      signed(writer, (index % 2 === 0 ? goal : otherGoal) + "/messages", data)));
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(LIMITS.messagesPerMinute);
    const limited = responses.find(({ status }) => status === 429)!;
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expectError(limited, 429, "rate_limited");
    await env.DB.prepare("UPDATE messages SET created_at = ?").bind(new Date(Date.now() - 61_000).toISOString()).run();
    expect((await signed(writer, goal + "/messages", data)).status).toBe(201);
  });

  test("counts rejected submissions towards the rolling limit", async () => {
    const solver = await agent("limited-solver");
    const data = { payload: { tour: [] } };
    const responses = await Promise.all(Array.from({ length: LIMITS.submissionsPerMinute + 1 }, () =>
      signed(solver, goal + "/submissions", data)));
    expect(responses.filter(({ status }) => status === 201)).toHaveLength(LIMITS.submissionsPerMinute);
    const limited = responses.find(({ status }) => status === 429)!;
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expectError(limited, 429, "rate_limited");
  });

  test("allows twenty registrations per IP in an hour", async () => {
    const keys = await generateAgentKeys();
    const data = { publicKey: keys.publicKey, handle: "registration-rate", kind: "codex" };
    const ip = "192.0.2.1";
    for (let attempt = 0; attempt < 20; attempt++) {
      expect((await signed(keys, "/api/agents", data, { ip })).status).toBe(attempt === 0 ? 201 : 200);
    }
    const limited = await signed(keys, "/api/agents", data, { ip });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expectError(limited, 429, "rate_limited");
    expect((await signed(keys, "/api/agents", data, { ip: "192.0.2.2" })).status).toBe(200);
  });
});

describe("activity", () => {
  test("returns chronological latest and catch-up pages with a global high-water mark", async () => {
    const keys = await agent("feed-agent");
    const first = await claim(keys);
    await signed(keys, otherGoal + "/messages", { kind: "finding", body: "Other goal" });
    await submit(keys);
    const { events: all, latestSeq } = await json<FeedResponse>(await get("/api/feed"));
    expect(all.map(({ type }) => type)).toEqual([
      "agent.registered", "claim.created", "message.created", "submission.created", "goal.improved",
    ]);
    expect(all[1]?.data).toMatchObject({ id: first.id });
    const { events: latest } = await json<FeedResponse>(await get("/api/feed?limit=2"));
    expect(latest).toEqual(all.slice(-2));
    const query = "/api/feed?limit=2&after=" + all[0]?.seq;
    expect(await json<FeedResponse>(await get(query))).toEqual({ events: all.slice(1, 3), latestSeq });
    expect(await json<FeedResponse>(await get(query + "&goalId=tsp-200"))).toEqual({
      events: [all[1], all[3]], latestSeq,
    });
    expect(await json<FeedResponse>(await get("/api/feed?goalId=tsp-1000"))).toEqual({
      events: [all[2]], latestSeq,
    });
  });

  test("upgrades to a WebSocket, sends ordered goal-filtered frames, and responds to ping", async () => {
    const keys = await agent("live-agent");
    const { latestSeq } = await json<FeedResponse>(await get("/api/feed"));
    const response = await SELF.fetch(base + "/api/live?goalId=tsp-200", { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const frames: (LiveFrame | "pong")[] = [];
    let ready!: () => void;
    const complete = new Promise<void>((resolve) => { ready = resolve; });
    socket.addEventListener("message", (frame) => {
      const value = frame.data === "pong" ? "pong" : JSON.parse(String(frame.data)) as LiveFrame;
      frames.push(value);
      if (value !== "pong" && value.type === "event" && value.event.type === "goal.improved") socket.send("ping");
      if (value === "pong") ready();
    });
    socket.accept();
    try {
      await signed(keys, otherGoal + "/messages", { kind: "finding", body: "Filtered out" });
      const { submission } = await submit(keys);
      await complete;
      expect(frames).toMatchObject([
        { type: "hello", latestSeq, serverTime: expect.any(String) },
        { type: "event", event: { type: "submission.created", goalId: "tsp-200", data: { id: submission.id } } },
        { type: "event", event: { type: "goal.improved", goalId: "tsp-200", data: { submissionId: submission.id } } },
        "pong",
      ]);
    } finally {
      socket.close(1000, "done");
    }
  });
});
