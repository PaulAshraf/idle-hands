import type {
  AgentWithStats, Claim, GoalDetail, GoalSummary, Objective, Stats, Submission, SubmissionWithPayload,
} from "@idle-hands/protocol";

export type SubmissionRow = Omit<Submission, "isBest"> & { isBest: 0 | 1 };
type GoalRow = Omit<GoalDetail, "params"> & { params: string };
type AgentStatsRow = Omit<AgentWithStats, "stats"> & AgentWithStats["stats"];

export const scoreOrder = (objective: Objective) => objective === "minimize" ? "ASC" : "DESC";
export const betterThan = (objective: Objective) => objective === "minimize" ? "<" : ">";

export function decodeSubmission(row: SubmissionRow): Submission {
  return { ...row, isBest: row.isBest === 1 };
}

export function decodeClaim(row: Claim, now: string): Claim {
  return row.status === "active" && row.expiresAt <= now ? { ...row, status: "expired" } : row;
}

export function resultRow<T>(result: D1Result): T | undefined {
  return result.results[0] as T | undefined;
}

export async function submissionWithPayload(db: D1Database, id: string): Promise<SubmissionWithPayload | null> {
  const row = await db.prepare(`
    SELECT d.*, s.payload FROM submission_details d JOIN submissions s USING (id) WHERE d.id = ?
  `).bind(id).first<SubmissionRow & { payload: string }>();
  if (!row) return null;
  const { payload, ...submission } = row;
  return { ...decodeSubmission(submission), payload: JSON.parse(payload) };
}

const goalSummary = `
  SELECT g.id, g.title, g.summary, g.verifier, g.objective, g.score_label AS scoreLabel,
         g.status, g.created_at AS createdAt, g.best_score AS bestScore,
         g.best_submission_id AS bestSubmissionId, g.best_agent_id AS bestAgentId,
         a.handle AS bestAgentHandle, g.best_at AS bestAt,
         (SELECT COUNT(*) FROM submissions s WHERE s.goal_id = g.id) AS submissionCount,
         (SELECT COUNT(*) FROM submissions s WHERE s.goal_id = g.id AND s.status = 'accepted') AS acceptedCount,
         (SELECT COUNT(DISTINCT s.agent_id) FROM submissions s WHERE s.goal_id = g.id) AS agentCount,
         (SELECT COUNT(*) FROM claims c WHERE c.goal_id = g.id AND c.status = 'active' AND c.expires_at > ?) AS activeClaimCount,
         (SELECT MAX(e.at) FROM events e WHERE e.goal_id = g.id) AS lastActivityAt
  FROM goals g LEFT JOIN agents a ON a.id = g.best_agent_id
`;

export async function listGoals(db: D1Database, now: string, before: string | null, limit: number) {
  const { results } = await db.prepare(`
    WITH cursor_order AS (
      SELECT g.id, ROW_NUMBER() OVER (
        ORDER BY g.status = 'open' DESC,
                 (SELECT MAX(e.at) FROM events e WHERE e.goal_id = g.id) DESC, g.id
      ) AS position
      FROM goals g
    ), page AS (
      SELECT id, position FROM cursor_order
      WHERE ? IS NULL OR position > (SELECT position FROM cursor_order WHERE id = ?)
      ORDER BY position LIMIT ?
    )
    ${goalSummary} JOIN page ON page.id = g.id ORDER BY page.position
  `).bind(before, before, limit, now).all<GoalSummary>();
  return results;
}

export async function goalDetail(db: D1Database, id: string, now: string): Promise<GoalDetail | null> {
  const row = await db.prepare(`
    WITH summary AS (${goalSummary} WHERE g.id = ?)
    SELECT summary.*, g.description, g.params, g.payload_help AS payloadHelp
    FROM summary JOIN goals g USING (id)
  `).bind(now, id).first<GoalRow>();
  return row && { ...row, params: JSON.parse(row.params) };
}

export interface GoalConfig {
  id: string;
  verifier: string;
  objective: Objective;
  status: GoalSummary["status"];
  params: string;
  best_score: number | null;
  best_submission_id: string | null;
}

export function goalConfig(db: D1Database, id: string) {
  return db.prepare(`
    SELECT id, verifier, objective, status, params, best_score, best_submission_id FROM goals WHERE id = ?
  `).bind(id).first<GoalConfig>();
}

const improvementCount = "(SELECT COUNT(*) FROM submissions s WHERE s.agent_id = a.id AND s.is_best = 1)";
const agentStats = `
  SELECT a.*,
         (SELECT COUNT(*) FROM submissions s WHERE s.agent_id = a.id) AS submissions,
         (SELECT COUNT(*) FROM submissions s WHERE s.agent_id = a.id AND s.status = 'accepted') AS accepted,
         ${improvementCount} AS improvements,
         (SELECT COUNT(*) FROM goals g WHERE g.best_agent_id = a.id) AS bestsHeld,
         (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id) AS messages,
         (SELECT COUNT(*) FROM claims c WHERE c.agent_id = a.id) AS claims,
         (SELECT COUNT(DISTINCT s.goal_id) FROM submissions s WHERE s.agent_id = a.id) AS goals
  FROM agent_profiles a
`;

function decodeAgentStats(row: AgentStatsRow): AgentWithStats {
  const { submissions, accepted, improvements, bestsHeld, messages, claims, goals, ...agent } = row;
  return { ...agent, stats: { submissions, accepted, improvements, bestsHeld, messages, claims, goals } };
}

export async function agentWithStats(db: D1Database, idOrHandle: string) {
  const row = await db.prepare(`
    ${agentStats} WHERE a.id = ? OR a.handle = ? ORDER BY a.id = ? DESC LIMIT 1
  `).bind(idOrHandle, idOrHandle, idOrHandle).first<AgentStatsRow>();
  return row && decodeAgentStats(row);
}

export async function listAgents(db: D1Database, sort: string, before: string | null, limit: number) {
  const order = sort === "improvements" ? `${improvementCount} DESC, a.lastSeenAt DESC` : "a.lastSeenAt DESC";
  const { results } = await db.prepare(`
    WITH cursor_order AS (
      SELECT a.id, ROW_NUMBER() OVER (ORDER BY ${order}, a.id) AS position FROM agent_profiles a
    ), page AS (
      SELECT id, position FROM cursor_order
      WHERE ? IS NULL OR position > (SELECT position FROM cursor_order WHERE id = ?)
      ORDER BY position LIMIT ?
    )
    ${agentStats} JOIN page ON page.id = a.id ORDER BY page.position
  `).bind(before, before, limit).all<AgentStatsRow>();
  return results.map(decodeAgentStats);
}

export function siteStats(db: D1Database, now: string, dayAgo: string) {
  return db.prepare(`
    SELECT (SELECT COUNT(*) FROM goals) AS goals,
           (SELECT COUNT(*) FROM agents) AS agents,
           (SELECT COUNT(*) FROM agents WHERE last_seen_at >= ?) AS activeAgents24h,
           (SELECT COUNT(*) FROM submissions) AS submissions,
           (SELECT COUNT(*) FROM submissions WHERE status = 'accepted') AS acceptedSubmissions,
           (SELECT COUNT(*) FROM submissions WHERE is_best = 1) AS improvements,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM claims WHERE status = 'active' AND expires_at > ?) AS activeClaims
  `).bind(dayAgo, now).first<Stats>();
}
