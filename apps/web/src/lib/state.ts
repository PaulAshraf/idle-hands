import { isBetter } from "@idle-hands/protocol/verifiers";
import type {
  BestPoint,
  Claim,
  FeedEvent,
  GoalDetail,
  GoalSummary,
  LeaderboardEntry,
  Message,
  Objective,
  Stats,
  Submission,
  SubmissionWithPayload,
} from "@idle-hands/protocol";

/** Insert or replace `item` (matched by id) in a list sorted newest-first by id (ULIDs sort by time). Returns a new list. */
export function upsertNewestFirst<T extends { id: string }>(list: readonly T[], item: T, cap = 100): T[] {
  const without = list.filter((x) => x.id !== item.id);
  let i = 0;
  while (i < without.length && without[i]!.id > item.id) i++;
  without.splice(i, 0, item);
  return without.length > cap ? without.slice(0, cap) : without;
}

/** Append a global-best point to an oldest-first history, ignoring duplicates (same submission). */
export function addHistoryPoint(history: readonly BestPoint[], point: BestPoint): BestPoint[] {
  if (history.some((p) => p.submissionId === point.submissionId)) return history.slice();
  const out = [...history, point];
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

// ------------------------------------------------------------------ goal page

export interface GoalSnapshot {
  goal: GoalDetail;
  best: SubmissionWithPayload | null;
  history: BestPoint[];
  leaderboard: LeaderboardEntry[];
  claims: Claim[];
  messages: Message[];
  submissions: Submission[];
}

export interface Flash {
  /** Counter, so the same agent improving twice in a row still re-triggers the banner. */
  n: number;
  agentId: string;
  agentHandle: string;
  score: number;
}

export interface GoalViewState {
  snapshot: GoalSnapshot | null;
  /** Live events that arrived before the snapshot did. They are applied right after it. */
  pending: FeedEvent[];
  flash: Flash | null;
}

export type GoalAction =
  | { type: "snapshot"; snapshot: GoalSnapshot }
  | { type: "event"; event: FeedEvent; replay: boolean }
  | { type: "goal"; goal: GoalDetail }
  | { type: "best"; submission: SubmissionWithPayload | null }
  | { type: "leaderboard"; entries: LeaderboardEntry[] }
  | { type: "history"; points: BestPoint[] };

export const initialGoalState: GoalViewState = { snapshot: null, pending: [], flash: null };

/** What a live event asks the page to refetch (they are throttled by the caller). */
export type Refetch = "goal" | "best" | "leaderboard";

export function refetchesFor(event: FeedEvent): Refetch[] {
  switch (event.type) {
    case "submission.created":
      return event.data.status === "accepted" ? ["goal", "leaderboard"] : ["goal"];
    case "goal.improved":
      return ["best", "goal", "leaderboard"];
    default:
      return [];
  }
}

/** Keeps the replacement only when it is the same or newer than what we hold, so out-of-order fetches never regress the view. */
export function pickBest(
  objective: Objective,
  current: SubmissionWithPayload | null,
  incoming: SubmissionWithPayload | null,
): SubmissionWithPayload | null {
  if (!incoming) return current;
  if (!current || current.id === incoming.id) return incoming;
  if (incoming.score === null) return current;
  if (current.score === null) return incoming;
  if (isBetter(objective, incoming.score, current.score)) return incoming;
  return current;
}

function applyEvent(snap: GoalSnapshot, event: FeedEvent): GoalSnapshot {
  const goalId = snap.goal.id;
  switch (event.type) {
    case "submission.created": {
      if (event.data.goalId !== goalId) return snap;
      return { ...snap, submissions: upsertNewestFirst(snap.submissions, event.data, 100) };
    }
    case "goal.improved": {
      const d = event.data;
      if (d.goalId !== goalId) return snap;
      const objective = snap.goal.objective;
      const point: BestPoint = { at: event.at, score: d.score, agentId: d.agentId, agentHandle: d.agentHandle, submissionId: d.submissionId };
      const history = addHistoryPoint(snap.history, point);
      const newer = isBetter(objective, d.score, snap.goal.bestScore) || d.submissionId === snap.goal.bestSubmissionId;
      const goal = newer
        ? { ...snap.goal, bestScore: d.score, bestAgentId: d.agentId, bestAgentHandle: d.agentHandle, bestSubmissionId: d.submissionId, bestAt: event.at }
        : snap.goal;
      return { ...snap, history, goal };
    }
    case "claim.created":
    case "claim.updated": {
      if (event.data.goalId !== goalId) return snap;
      const claims = upsertNewestFirst(snap.claims, event.data, 60);
      return { ...snap, claims, goal: { ...snap.goal, activeClaimCount: claims.filter((c) => c.status === "active").length } };
    }
    case "message.created": {
      if (event.data.goalId !== goalId) return snap;
      return { ...snap, messages: upsertNewestFirst(snap.messages, event.data, 100) };
    }
    default:
      return snap;
  }
}

export function goalReducer(state: GoalViewState, action: GoalAction): GoalViewState {
  switch (action.type) {
    case "snapshot": {
      let snapshot = action.snapshot;
      for (const e of state.pending) snapshot = applyEvent(snapshot, e);
      return { ...state, snapshot, pending: [] };
    }
    case "event": {
      const { event, replay } = action;
      if (!state.snapshot) return { ...state, pending: [...state.pending, event] };
      const snapshot = applyEvent(state.snapshot, event);
      let flash = state.flash;
      if (!replay && event.type === "goal.improved" && event.data.goalId === state.snapshot.goal.id && snapshot !== state.snapshot) {
        flash = { n: (state.flash?.n ?? 0) + 1, agentId: event.data.agentId, agentHandle: event.data.agentHandle, score: event.data.score };
      }
      return { ...state, snapshot, flash };
    }
    case "goal": {
      if (!state.snapshot) return state;
      // Counters come from the server; never let a late response drag the best score backwards.
      const cur = state.snapshot.goal;
      const keepBest = action.goal.bestScore !== null && cur.bestScore !== null && isBetter(cur.objective, cur.bestScore, action.goal.bestScore);
      const goal: GoalDetail = keepBest
        ? { ...action.goal, bestScore: cur.bestScore, bestAgentId: cur.bestAgentId, bestAgentHandle: cur.bestAgentHandle, bestSubmissionId: cur.bestSubmissionId, bestAt: cur.bestAt }
        : action.goal;
      return { ...state, snapshot: { ...state.snapshot, goal } };
    }
    case "best": {
      if (!state.snapshot) return state;
      const best = pickBest(state.snapshot.goal.objective, state.snapshot.best, action.submission);
      return best === state.snapshot.best ? state : { ...state, snapshot: { ...state.snapshot, best } };
    }
    case "leaderboard":
      return state.snapshot ? { ...state, snapshot: { ...state.snapshot, leaderboard: action.entries } } : state;
    case "history": {
      if (!state.snapshot) return state;
      let history = action.points;
      for (const p of state.snapshot.history) history = addHistoryPoint(history, p);
      return { ...state, snapshot: { ...state.snapshot, history } };
    }
  }
}

// ------------------------------------------------------------------ home page

export interface HomeSnapshot {
  stats: Stats;
  goals: GoalSummary[];
  histories: Record<string, BestPoint[]>;
}

export interface HomeViewState {
  snapshot: HomeSnapshot | null;
  /** Newest first. */
  ticker: FeedEvent[];
}

export type HomeAction =
  | { type: "snapshot"; snapshot: HomeSnapshot }
  | { type: "stats"; stats: Stats }
  | { type: "goals"; goals: GoalSummary[] }
  | { type: "history"; goalId: string; points: BestPoint[] }
  | { type: "event"; event: FeedEvent };

export const TICKER_CAP = 40;
export const initialHomeState: HomeViewState = { snapshot: null, ticker: [] };

/** Insert into a newest-first ticker, dropping duplicates by seq. */
export function pushTicker(ticker: readonly FeedEvent[], event: FeedEvent, cap = TICKER_CAP): FeedEvent[] {
  if (ticker.some((e) => e.seq === event.seq)) return ticker.slice();
  const out = [...ticker, event].sort((a, b) => b.seq - a.seq);
  return out.length > cap ? out.slice(0, cap) : out;
}

export function homeReducer(state: HomeViewState, action: HomeAction): HomeViewState {
  switch (action.type) {
    case "snapshot":
      return { ...state, snapshot: action.snapshot };
    case "stats":
      return state.snapshot ? { ...state, snapshot: { ...state.snapshot, stats: action.stats } } : state;
    case "goals":
      return state.snapshot ? { ...state, snapshot: { ...state.snapshot, goals: action.goals } } : state;
    case "history": {
      if (!state.snapshot) return state;
      let points = action.points;
      for (const p of state.snapshot.histories[action.goalId] ?? []) points = addHistoryPoint(points, p);
      return { ...state, snapshot: { ...state.snapshot, histories: { ...state.snapshot.histories, [action.goalId]: points } } };
    }
    case "event": {
      const e = action.event;
      const ticker = pushTicker(state.ticker, e);
      if (!state.snapshot || e.type !== "goal.improved") return { ...state, ticker };
      const d = e.data;
      const histories = {
        ...state.snapshot.histories,
        [d.goalId]: addHistoryPoint(state.snapshot.histories[d.goalId] ?? [], {
          at: e.at,
          score: d.score,
          agentId: d.agentId,
          agentHandle: d.agentHandle,
          submissionId: d.submissionId,
        }),
      };
      return { ...state, ticker, snapshot: { ...state.snapshot, histories } };
    }
  }
}

// ------------------------------------------------------------------ misc

/** Claims that are still live at `now`: active and not past their lease. */
export function liveClaims(claims: readonly Claim[], now: number): Claim[] {
  return claims.filter((c) => c.status === "active" && Date.parse(c.expiresAt) > now);
}

/** Display status: a lease that ran out reads as expired even if no event said so yet. */
export function effectiveClaimStatus(claim: Claim, now: number): Claim["status"] {
  return claim.status === "active" && Date.parse(claim.expiresAt) <= now ? "expired" : claim.status;
}
