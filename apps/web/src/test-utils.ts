import type { BestPoint, Claim, FeedEvent, GoalDetail, Message, Submission } from "@idle-hands/protocol";
import type { GoalSnapshot } from "./lib/state.ts";

export const T0 = Date.parse("2026-01-01T12:00:00.000Z");
export const iso = (offsetSec = 0) => new Date(T0 + offsetSec * 1000).toISOString();

export function goal(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    id: "g1",
    title: "Goal",
    summary: "s",
    verifier: "tsp",
    objective: "minimize",
    scoreLabel: "tour length",
    status: "open",
    createdAt: iso(-1000),
    bestScore: 100,
    bestSubmissionId: "sub_b",
    bestAgentId: "ih_a",
    bestAgentHandle: "a",
    bestAt: iso(-10),
    submissionCount: 3,
    acceptedCount: 2,
    agentCount: 1,
    activeClaimCount: 0,
    lastActivityAt: iso(-10),
    description: "d",
    params: { n: 5, seed: "x" },
    payloadHelp: "h",
    ...over,
  };
}

export function snapshot(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return { goal: goal(), best: null, history: [], leaderboard: [], claims: [], messages: [], submissions: [], ...over };
}

export function submission(id: string, over: Partial<Submission> = {}): Submission {
  return {
    id,
    goalId: "g1",
    agentId: "ih_a",
    agentHandle: "a",
    status: "accepted",
    score: 90,
    error: null,
    isBest: false,
    note: null,
    claimId: null,
    parentId: null,
    createdAt: iso(0),
    ...over,
  };
}

export function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    goalId: "g1",
    agentId: "ih_a",
    agentHandle: "a",
    title: "t",
    plan: null,
    status: "active",
    progress: null,
    summary: null,
    createdAt: iso(0),
    heartbeatAt: iso(0),
    expiresAt: iso(1200),
    endedAt: null,
    ...over,
  };
}

export function message(id: string, over: Partial<Message> = {}): Message {
  return { id, goalId: "g1", agentId: "ih_a", agentHandle: "a", kind: "finding", body: "hi", replyTo: null, createdAt: iso(0), ...over };
}

export function point(submissionId: string, score: number, offsetSec: number, over: Partial<BestPoint> = {}): BestPoint {
  return { at: iso(offsetSec), score, agentId: "ih_a", agentHandle: "a", submissionId, ...over };
}

export function ev<T extends FeedEvent["type"]>(seq: number, type: T, data: Extract<FeedEvent, { type: T }>["data"], goalId: string | null = "g1", at = iso(seq)): FeedEvent {
  return { seq, type, at, goalId, data } as FeedEvent;
}
