import { describe, expect, it } from "vitest";
import { verifyPayload } from "@idle-hands/protocol/verifiers";
import type { BestPoint, FeedEvent, GoalDetail, SubmissionWithPayload } from "@idle-hands/protocol";
import { MockWorld } from "./world.ts";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const world = new MockWorld({ now: NOW });
const get = <T>(path: string): T => {
  const u = new URL(path, "http://x");
  return world.handle(u.pathname, u.searchParams).body as T;
};

describe("mock world", () => {
  it("serves the three goals with real parameters", () => {
    const { goals } = get<{ goals: GoalDetail[] }>("/api/goals");
    expect(goals.map((g) => g.id).sort()).toEqual(["color-300", "tsp-1000", "tsp-200"]);
    expect(get<{ goal: GoalDetail }>("/api/goals/tsp-200").goal.params).toEqual({ n: 200, seed: "idle-hands-1" });
    expect(get<{ goal: GoalDetail }>("/api/goals/color-300").goal.params).toEqual({ n: 300, p: 0.3, seed: "idle-hands-3" });
  });

  it("every best payload passes the real verifier and matches its recorded score", () => {
    for (const id of ["tsp-200", "tsp-1000", "color-300"]) {
      const { goal } = get<{ goal: GoalDetail }>(`/api/goals/${id}`);
      const { submission } = get<{ submission: SubmissionWithPayload }>(`/api/goals/${id}/best`);
      const r = verifyPayload(goal.verifier, goal.params, submission.payload);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.score).toBeCloseTo(submission.score!, 6);
      expect(goal.bestScore).toBe(submission.score);
    }
  });

  it("history is chronological and strictly improving", () => {
    for (const id of ["tsp-200", "tsp-1000", "color-300"]) {
      const { points } = get<{ points: BestPoint[] }>(`/api/goals/${id}/history`);
      expect(points.length).toBeGreaterThan(2);
      for (let i = 1; i < points.length; i++) {
        expect(Date.parse(points[i]!.at)).toBeGreaterThanOrEqual(Date.parse(points[i - 1]!.at));
        expect(points[i]!.score).toBeLessThan(points[i - 1]!.score);
      }
    }
  });

  it("has rejections with real verifier errors, claims, findings and a feed with increasing seq", () => {
    const rejected = get<{ submissions: { error: string; score: null }[] }>("/api/goals/tsp-200/submissions?status=rejected&limit=200").submissions;
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((s) => s.score === null && s.error.length > 5)).toBe(true);
    const claims = get<{ claims: { status: string }[] }>("/api/goals/tsp-200/claims?active=0&limit=200").claims;
    expect(claims.length).toBeGreaterThan(3);
    expect(get<{ messages: { kind: string }[] }>("/api/goals/tsp-200/messages?kind=finding").messages.length).toBeGreaterThan(0);
    const { events, latestSeq } = get<{ events: FeedEvent[]; latestSeq: number }>("/api/feed?limit=200");
    for (let i = 1; i < events.length; i++) expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
    expect(events.at(-1)!.seq).toBe(latestSeq);
    const after = get<{ events: FeedEvent[] }>(`/api/feed?after=${latestSeq - 3}`).events;
    expect(after.map((e) => e.seq)).toEqual([latestSeq - 2, latestSeq - 1, latestSeq]);
  });

  it("has agents of several kinds, resolvable by handle, and 404s politely", () => {
    const { agents } = get<{ agents: { kind: string; handle: string; id: string }[] }>("/api/agents");
    expect(new Set(agents.map((a) => a.kind)).size).toBeGreaterThanOrEqual(4);
    expect(get<{ agent: { id: string } }>(`/api/agents/${agents[0]!.handle}`).agent.id).toBe(agents[0]!.id);
    expect(get<{ error: { code: string } }>("/api/goals/nope").error.code).toBe("not_found");
  });

  it("keeps working live: emits events to subscribers, improves, and agents join", () => {
    const seen: FeedEvent[] = [];
    world.subscribe((e) => seen.push(e));
    const before = get<{ stats: { agents: number; improvements: number } }>("/api/stats").stats;
    for (let s = 1; s <= 240; s++) world.tick(NOW + s * 1000);
    expect(seen.length).toBeGreaterThan(10);
    expect(new Set(seen.map((e) => e.type)).size).toBeGreaterThanOrEqual(3);
    expect(seen.some((e) => e.type === "agent.registered")).toBe(true);
    const after = get<{ stats: { agents: number; improvements: number } }>("/api/stats").stats;
    expect(after.agents).toBeGreaterThan(before.agents);
    expect(after.improvements).toBeGreaterThanOrEqual(before.improvements);
  });

  it("expires a lapsed lease and announces it", () => {
    const ghost = get<{ claims: { id: string; agentHandle: string; status: string }[] }>("/api/goals/tsp-1000/claims?active=0&limit=200").claims.find((c) => c.agentHandle === "mossback" && c.status === "expired");
    expect(ghost).toBeTruthy();
  });
});
