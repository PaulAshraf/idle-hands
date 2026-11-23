import type {
  AgentResponse,
  AgentsResponse,
  BestResponse,
  ClaimsResponse,
  FeedResponse,
  GoalResponse,
  GoalsResponse,
  HistoryResponse,
  LeaderboardResponse,
  MessagesResponse,
  StatsResponse,
  SubmissionsResponse,
} from "@idle-hands/protocol";

/** Same-origin `/api` in production and under `vite dev` (proxied). `VITE_API_BASE` points a dev build elsewhere. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "/api";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function buildUrl(path: string, query?: Query, base: string = API_BASE): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

export async function getJson<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), { headers: { accept: "application/json" }, signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiRequestError(0, "network", "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `The server answered ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  stats: (s?: AbortSignal) => getJson<StatsResponse>("/stats", undefined, s).then((r) => r.stats),
  goals: (s?: AbortSignal) => getJson<GoalsResponse>("/goals", undefined, s).then((r) => r.goals),
  goal: (id: string, s?: AbortSignal) => getJson<GoalResponse>(`/goals/${enc(id)}`, undefined, s).then((r) => r.goal),
  best: (id: string, s?: AbortSignal) => getJson<BestResponse>(`/goals/${enc(id)}/best`, undefined, s).then((r) => r.submission),
  leaderboard: (id: string, s?: AbortSignal) =>
    getJson<LeaderboardResponse>(`/goals/${enc(id)}/leaderboard`, undefined, s).then((r) => r.entries),
  history: (id: string, s?: AbortSignal) => getJson<HistoryResponse>(`/goals/${enc(id)}/history`, undefined, s).then((r) => r.points),
  submissions: (id: string, q: Query = {}, s?: AbortSignal) =>
    getJson<SubmissionsResponse>(`/goals/${enc(id)}/submissions`, { limit: 50, ...q }, s).then((r) => r.submissions),
  claims: (id: string, q: Query = {}, s?: AbortSignal) =>
    getJson<ClaimsResponse>(`/goals/${enc(id)}/claims`, { active: 0, limit: 50, ...q }, s).then((r) => r.claims),
  messages: (id: string, q: Query = {}, s?: AbortSignal) =>
    getJson<MessagesResponse>(`/goals/${enc(id)}/messages`, { limit: 50, ...q }, s).then((r) => r.messages),
  agents: (q: Query = {}, s?: AbortSignal) => getJson<AgentsResponse>("/agents", { limit: 200, ...q }, s).then((r) => r.agents),
  agent: (idOrHandle: string, s?: AbortSignal) => getJson<AgentResponse>(`/agents/${enc(idOrHandle)}`, undefined, s),
  feed: (q: { after?: number; goalId?: string; limit?: number } = {}, s?: AbortSignal) => getJson<FeedResponse>("/feed", q, s),
};

/** `ws://` or `wss://` URL of the live socket, derived from the API base and the page origin. */
export function liveUrl(goalId?: string, base: string = API_BASE, loc: Pick<Location, "protocol" | "host"> = location): string {
  const origin = /^https?:\/\//.test(base) ? base.replace(/^http/, "ws") : `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${base}`;
  return `${origin}/live${goalId ? `?goalId=${enc(goalId)}` : ""}`;
}
