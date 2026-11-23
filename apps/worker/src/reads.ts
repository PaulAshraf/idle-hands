import {
  MESSAGE_KINDS, SUBMISSION_STATUSES,
  type AgentResponse, type AgentsResponse, type BestPoint, type BestResponse, type Claim, type ClaimsResponse,
  type FeedResponse, type GoalResponse, type GoalsResponse, type HealthResponse, type HistoryResponse,
  type LeaderboardEntry, type LeaderboardResponse, type MeResponse, type Message, type MessagesResponse,
  type StatsResponse, type SubmissionResponse, type SubmissionsResponse,
} from "@idle-hands/protocol";
import { buildInstance } from "@idle-hands/protocol/verifiers";
import { Hono } from "hono";
import { authenticate } from "./auth.ts";
import { decodeEvent, eventColumns, liveHub, type EventRow } from "./events.ts";
import { badRequest, isoTime, notFound, pageSize, sequence, type AppContext, type AppEnv } from "./http.ts";
import {
  agentWithStats, decodeClaim, decodeSubmission, goalConfig, goalDetail, listAgents, listGoals, resultRow,
  scoreOrder, siteStats, submissionWithPayload, type SubmissionRow,
} from "./queries.ts";

function queryOption<T extends string>(c: AppContext, field: string, options: readonly T[]) {
  const value = c.req.query(field);
  if (value === undefined) return null;
  if (!options.includes(value as T)) badRequest(`${field} must be one of ${options.join(", ")}`);
  return value as T;
}

async function requireGoal(db: D1Database, id: string) {
  const goal = await goalConfig(db, id);
  if (!goal) notFound("Goal");
  return goal;
}

export const reads = new Hono<AppEnv>();

reads.get("/health", (c) => c.json<HealthResponse>({ ok: true, version: "0.1.0", serverTime: isoTime() }));

reads.get("/stats", async (c) => {
  const now = Date.now();
  const stats = await siteStats(c.env.DB, isoTime(now), isoTime(now - 24 * 60 * 60_000));
  return c.json<StatsResponse>({ stats: stats! });
});

reads.get("/goals", async (c) => {
  const goals = await listGoals(c.env.DB, isoTime(), c.req.query("before") ?? null, pageSize(c));
  return c.json<GoalsResponse>({ goals });
});

reads.get("/goals/:goalId", async (c) => {
  const goal = await goalDetail(c.env.DB, c.req.param("goalId"), isoTime());
  if (!goal) notFound("Goal");
  return c.json<GoalResponse>({ goal });
});

reads.get("/goals/:goalId/instance", async (c) => {
  const goal = await requireGoal(c.env.DB, c.req.param("goalId"));
  const instance = buildInstance(goal.verifier, JSON.parse(goal.params));
  c.header("Cache-Control", "public, max-age=86400");
  return c.json(instance);
});

reads.get("/goals/:goalId/best", async (c) => {
  const { DB } = c.env;
  const goal = await requireGoal(DB, c.req.param("goalId"));
  const submission = goal.best_submission_id && await submissionWithPayload(DB, goal.best_submission_id);
  return c.json<BestResponse>({ submission: submission || null });
});

reads.get("/goals/:goalId/leaderboard", async (c) => {
  const { DB } = c.env;
  const goal = await requireGoal(DB, c.req.param("goalId"));
  const order = scoreOrder(goal.objective);
  const before = c.req.query("before") ?? null;
  const { results: entries } = await DB.prepare(`
    WITH attempts AS (
      SELECT agent_id, id, score, status, created_at, rowid AS arrival,
             COUNT(*) OVER agent AS attempts,
             SUM(status = 'accepted') OVER agent AS accepted,
             SUM(is_best) OVER agent AS improvements,
             ROW_NUMBER() OVER (
               PARTITION BY agent_id ORDER BY status = 'accepted' DESC, score ${order}, created_at, rowid
             ) AS best
      FROM submissions WHERE goal_id = ?
      WINDOW agent AS (PARTITION BY agent_id)
    ), ranked AS (
      SELECT ROW_NUMBER() OVER (ORDER BY score ${order}, created_at, arrival) AS rank,
             agent_id AS agentId, score AS bestScore, id AS bestSubmissionId, created_at AS bestAt,
             accepted, attempts, improvements
      FROM attempts WHERE best = 1 AND status = 'accepted'
    )
    SELECT r.*, a.handle AS agentHandle, a.kind AS agentKind, a.operator
    FROM ranked r JOIN agents a ON a.id = r.agentId
    WHERE ? IS NULL OR r.rank > (
      SELECT rank FROM ranked WHERE bestSubmissionId = ? OR agentId = ? ORDER BY bestSubmissionId = ? DESC LIMIT 1
    )
    ORDER BY rank LIMIT ?
  `).bind(goal.id, before, before, before, before, pageSize(c)).all<LeaderboardEntry>();
  return c.json<LeaderboardResponse>({ entries });
});

reads.get("/goals/:goalId/history", async (c) => {
  const { DB } = c.env;
  const goal = await requireGoal(DB, c.req.param("goalId"));
  const before = c.req.query("before") ?? null;
  const { results } = await DB.prepare(`
    SELECT s.created_at AS at, s.score, s.agent_id AS agentId, a.handle AS agentHandle, s.id AS submissionId
    FROM submissions s JOIN agents a ON a.id = s.agent_id
    WHERE s.goal_id = ? AND s.is_best = 1 AND (? IS NULL OR s.id < ?)
    ORDER BY s.id DESC LIMIT ?
  `).bind(goal.id, before, before, pageSize(c)).all<BestPoint>();
  return c.json<HistoryResponse>({ points: results.reverse() });
});

reads.get("/goals/:goalId/submissions", async (c) => {
  const { DB } = c.env;
  const goal = await requireGoal(DB, c.req.param("goalId"));
  const status = queryOption(c, "status", SUBMISSION_STATUSES);
  const agent = c.req.query("agentId") ?? null;
  const before = c.req.query("before") ?? null;
  const { results } = await DB.prepare(`
    SELECT * FROM submission_details WHERE goalId = ?
    AND (? IS NULL OR id < ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR agentId = ?)
    ORDER BY id DESC LIMIT ?
  `).bind(goal.id, before, before, status, status, agent, agent, pageSize(c)).all<SubmissionRow>();
  return c.json<SubmissionsResponse>({ submissions: results.map(decodeSubmission) });
});

reads.get("/goals/:goalId/claims", async (c) => {
  const { DB } = c.env;
  const goal = await requireGoal(DB, c.req.param("goalId"));
  const active = queryOption(c, "active", ["0", "1"]) ?? "1";
  const before = c.req.query("before") ?? null;
  const now = isoTime();
  const { results } = await DB.prepare(`
    SELECT * FROM claim_details WHERE goalId = ? AND (? IS NULL OR id < ?)
    AND (? = '0' OR (status = 'active' AND expiresAt > ?)) ORDER BY id DESC LIMIT ?
  `).bind(goal.id, before, before, active, now, pageSize(c)).all<Claim>();
  return c.json<ClaimsResponse>({ claims: results.map((row) => decodeClaim(row, now)) });
});

reads.get("/goals/:goalId/messages", async (c) => {
  const { DB } = c.env;
  const goal = await requireGoal(DB, c.req.param("goalId"));
  const kind = queryOption(c, "kind", MESSAGE_KINDS);
  const before = c.req.query("before") ?? null;
  const { results: messages } = await DB.prepare(`
    SELECT * FROM message_details WHERE goalId = ?
    AND (? IS NULL OR id < ?) AND (? IS NULL OR kind = ?) ORDER BY id DESC LIMIT ?
  `).bind(goal.id, before, before, kind, kind, pageSize(c)).all<Message>();
  return c.json<MessagesResponse>({ messages });
});

reads.get("/submissions/:id", async (c) => {
  const submission = await submissionWithPayload(c.env.DB, c.req.param("id"));
  if (!submission) notFound("Submission");
  return c.json<SubmissionResponse>({ submission });
});

reads.get("/agents", async (c) => {
  const sort = queryOption(c, "sort", ["recent", "improvements"]) ?? "recent";
  const agents = await listAgents(c.env.DB, sort, c.req.query("before") ?? null, pageSize(c));
  return c.json<AgentsResponse>({ agents });
});

reads.get("/agents/:agentId", async (c) => {
  const { DB } = c.env;
  const agent = await agentWithStats(DB, c.req.param("agentId"));
  if (!agent) notFound("Agent");
  const { results } = await DB.prepare("SELECT * FROM submission_details WHERE agentId = ? ORDER BY id DESC LIMIT 20")
    .bind(agent.id).all<SubmissionRow>();
  return c.json<AgentResponse>({ agent, recentSubmissions: results.map(decodeSubmission) });
});

reads.get("/me", authenticate(), async (c) => {
  const agent = await agentWithStats(c.env.DB, c.get("agentId"));
  if (!agent) notFound("Agent");
  return c.json<MeResponse>({ agent });
});

reads.get("/feed", async (c) => {
  const { DB } = c.env;
  const goalId = c.req.query("goalId") ?? null;
  const after = sequence(c.req.query("after"), "after");
  const before = sequence(c.req.query("before"), "before");
  const filters: [string, string | number | null][] = [
    ["goal_id = ?", goalId], ["seq > ?", after], ["seq < ?", before],
  ];
  const activeFilters = filters.filter(([, value]) => value !== null);
  const where = activeFilters.length > 0 ? "WHERE " + activeFilters.map(([clause]) => clause).join(" AND ") : "";
  const [page, latest] = await DB.batch([
    DB.prepare(`
      SELECT ${eventColumns} FROM events ${where}
      ORDER BY seq ${after === null ? "DESC" : "ASC"} LIMIT ?
    `).bind(...activeFilters.map(([, value]) => value), pageSize(c)),
    DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events"),
  ]);
  const rows = page!.results as EventRow[];
  return c.json<FeedResponse>({
    events: (after === null ? rows.reverse() : rows).map(decodeEvent),
    latestSeq: resultRow<{ seq: number }>(latest!)!.seq,
  });
});

reads.get("/live", (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    badRequest("A WebSocket upgrade is required");
  }
  const goalId = c.req.query("goalId");
  if (goalId !== undefined && (goalId.length === 0 || new TextEncoder().encode(goalId).length > 256)) {
    badRequest("goalId must be between 1 and 256 bytes");
  }
  return liveHub(c.env).fetch(c.req.raw);
});
