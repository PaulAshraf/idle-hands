import { describe, expect, it } from "vitest";
import type { GoalImproved } from "@idle-hands/protocol";
import { addHistoryPoint, effectiveClaimStatus, goalReducer, homeReducer, initialGoalState, initialHomeState, liveClaims, pickBest, pushTicker, refetchesFor, TICKER_CAP, upsertNewestFirst, type GoalViewState } from "./state.ts";
import { claim, ev, goal, iso, message, point, snapshot, submission, T0 } from "../test-utils.ts";

const improved = (over: Partial<GoalImproved> = {}): GoalImproved => ({ goalId: "g1", score: 80, previousScore: 100, agentId: "ih_b", agentHandle: "b", submissionId: "sub_n", ...over });
const loaded = (snap = snapshot()): GoalViewState => goalReducer(initialGoalState, { type: "snapshot", snapshot: snap });

describe("upsertNewestFirst", () => {
  it("keeps id-descending order and replaces by id", () => {
    let l = upsertNewestFirst([], { id: "b", v: 1 });
    l = upsertNewestFirst(l, { id: "c", v: 1 });
    l = upsertNewestFirst(l, { id: "a", v: 1 });
    l = upsertNewestFirst(l, { id: "b", v: 2 });
    expect(l).toEqual([{ id: "c", v: 1 }, { id: "b", v: 2 }, { id: "a", v: 1 }]);
  });
  it("caps the list, dropping the oldest", () => {
    let l: { id: string }[] = [];
    for (const id of ["a", "b", "c", "d"]) l = upsertNewestFirst(l, { id }, 3);
    expect(l.map((x) => x.id)).toEqual(["d", "c", "b"]);
  });
});

describe("addHistoryPoint", () => {
  it("ignores duplicates and keeps time order", () => {
    let h = addHistoryPoint([], point("s2", 90, 60));
    h = addHistoryPoint(h, point("s1", 100, 0));
    h = addHistoryPoint(h, point("s2", 90, 60));
    expect(h.map((p) => p.submissionId)).toEqual(["s1", "s2"]);
  });
});

describe("goalReducer: events", () => {
  it("queues events that arrive before the snapshot and applies them after", () => {
    let s = goalReducer(initialGoalState, { type: "event", event: ev(1, "message.created", message("msg_1")), replay: false });
    expect(s.snapshot).toBeNull();
    expect(s.pending).toHaveLength(1);
    s = goalReducer(s, { type: "snapshot", snapshot: snapshot() });
    expect(s.pending).toHaveLength(0);
    expect(s.snapshot!.messages.map((m) => m.id)).toEqual(["msg_1"]);
  });

  it("submission.created lands in the stream once, even when delivered twice", () => {
    let s = loaded();
    const e = ev(1, "submission.created", submission("sub_1"));
    s = goalReducer(s, { type: "event", event: e, replay: false });
    s = goalReducer(s, { type: "event", event: e, replay: true });
    expect(s.snapshot!.submissions).toHaveLength(1);
  });

  it("ignores events for other goals", () => {
    const s = goalReducer(loaded(), { type: "event", event: ev(1, "submission.created", submission("sub_1", { goalId: "other" }), "other"), replay: false });
    expect(s.snapshot!.submissions).toHaveLength(0);
  });

  it("goal.improved extends the curve, updates the headline and flashes", () => {
    const s = goalReducer(loaded(snapshot({ history: [point("sub_b", 100, -10)] })), { type: "event", event: ev(2, "goal.improved", improved()), replay: false });
    expect(s.snapshot!.history.map((p) => p.score)).toEqual([100, 80]);
    expect(s.snapshot!.goal.bestScore).toBe(80);
    expect(s.snapshot!.goal.bestAgentHandle).toBe("b");
    expect(s.flash).toMatchObject({ n: 1, score: 80, agentHandle: "b" });
  });

  it("replayed improvements do not flash and never regress the best", () => {
    const base = loaded(snapshot({ goal: goal({ bestScore: 70, bestSubmissionId: "sub_z" }) }));
    const s = goalReducer(base, { type: "event", event: ev(2, "goal.improved", improved({ score: 80 })), replay: true });
    expect(s.flash).toBeNull();
    expect(s.snapshot!.goal.bestScore).toBe(70);
    expect(s.snapshot!.history).toHaveLength(1); // still recorded on the curve
  });

  it("respects maximize objectives", () => {
    const base = loaded(snapshot({ goal: goal({ objective: "maximize", bestScore: 10 }) }));
    const s = goalReducer(base, { type: "event", event: ev(2, "goal.improved", improved({ score: 12 })), replay: false });
    expect(s.snapshot!.goal.bestScore).toBe(12);
    const worse = goalReducer(s, { type: "event", event: ev(3, "goal.improved", improved({ score: 11, submissionId: "sub_o" })), replay: false });
    expect(worse.snapshot!.goal.bestScore).toBe(12);
  });

  it("claims upsert by id and the active count follows", () => {
    let s = loaded();
    s = goalReducer(s, { type: "event", event: ev(1, "claim.created", claim("clm_1")), replay: false });
    s = goalReducer(s, { type: "event", event: ev(2, "claim.created", claim("clm_2")), replay: false });
    expect(s.snapshot!.goal.activeClaimCount).toBe(2);
    s = goalReducer(s, { type: "event", event: ev(3, "claim.updated", claim("clm_1", { status: "succeeded" })), replay: false });
    expect(s.snapshot!.claims).toHaveLength(2);
    expect(s.snapshot!.goal.activeClaimCount).toBe(1);
  });

  it("messages are added newest first", () => {
    let s = loaded();
    s = goalReducer(s, { type: "event", event: ev(1, "message.created", message("msg_1")), replay: false });
    s = goalReducer(s, { type: "event", event: ev(2, "message.created", message("msg_2")), replay: false });
    expect(s.snapshot!.messages.map((m) => m.id)).toEqual(["msg_2", "msg_1"]);
  });
});

describe("goalReducer: fetched data", () => {
  it("never lets a stale goal response drag the best backwards", () => {
    const base = loaded(snapshot({ goal: goal({ bestScore: 70, bestSubmissionId: "sub_z" }) }));
    const s = goalReducer(base, { type: "goal", goal: goal({ bestScore: 90, submissionCount: 50 }) });
    expect(s.snapshot!.goal.bestScore).toBe(70);
    expect(s.snapshot!.goal.submissionCount).toBe(50);
  });
  it("pickBest keeps the better of two out-of-order responses", () => {
    const sub = (id: string, score: number) => ({ ...submission(id, { score }), payload: {} });
    expect(pickBest("minimize", sub("a", 80), sub("b", 90))!.id).toBe("a");
    expect(pickBest("minimize", sub("a", 90), sub("b", 80))!.id).toBe("b");
    expect(pickBest("minimize", null, sub("b", 80))!.id).toBe("b");
    expect(pickBest("minimize", sub("a", 80), null)!.id).toBe("a");
  });
  it("history merge keeps points learned from live events", () => {
    const base = loaded(snapshot({ history: [point("s1", 100, 0), point("live", 90, 50)] }));
    const s = goalReducer(base, { type: "history", points: [point("s1", 100, 0)] });
    expect(s.snapshot!.history.map((p) => p.submissionId)).toEqual(["s1", "live"]);
  });
});

describe("refetchesFor", () => {
  it("asks for what a live event can't carry", () => {
    expect(refetchesFor(ev(1, "goal.improved", improved()))).toContain("best");
    expect(refetchesFor(ev(1, "submission.created", submission("s")))).toEqual(["goal", "leaderboard"]);
    expect(refetchesFor(ev(1, "submission.created", submission("s", { status: "rejected", score: null, error: "x" })))).toEqual(["goal"]);
    expect(refetchesFor(ev(1, "message.created", message("m")))).toEqual([]);
  });
});

describe("home reducer", () => {
  it("keeps the ticker newest-first, de-duplicated and capped", () => {
    let t: ReturnType<typeof pushTicker> = [];
    for (let i = 1; i <= TICKER_CAP + 10; i++) t = pushTicker(t, ev(i, "message.created", message(`m${i}`)));
    t = pushTicker(t, ev(TICKER_CAP + 10, "message.created", message("dup")));
    expect(t).toHaveLength(TICKER_CAP);
    expect(t[0]!.seq).toBe(TICKER_CAP + 10);
    expect(new Set(t.map((e) => e.seq)).size).toBe(TICKER_CAP);
  });
  it("extends sparkline history when a goal improves", () => {
    let s = homeReducer(initialHomeState, {
      type: "snapshot",
      snapshot: { stats: { goals: 1, agents: 0, activeAgents24h: 0, submissions: 0, acceptedSubmissions: 0, improvements: 0, messages: 0, activeClaims: 0 }, goals: [], histories: { g1: [point("s1", 100, 0)] } },
    });
    s = homeReducer(s, { type: "event", event: ev(1, "goal.improved", improved()) });
    s = homeReducer(s, { type: "event", event: ev(1, "goal.improved", improved()) });
    expect(s.snapshot!.histories.g1!.map((p) => p.score)).toEqual([100, 80]);
    expect(s.ticker).toHaveLength(1);
  });
});

describe("claim helpers", () => {
  it("treats a lapsed lease as expired", () => {
    const now = T0 + 1300_000;
    const c = claim("c", { expiresAt: iso(1200) });
    expect(effectiveClaimStatus(c, now)).toBe("expired");
    expect(effectiveClaimStatus(c, T0)).toBe("active");
    expect(liveClaims([c, claim("d", { status: "failed" })], T0)).toHaveLength(1);
    expect(liveClaims([c], now)).toHaveLength(0);
  });
});
