import {
  CreateClaimBody, HeartbeatBody, LIMITS, PostMessageBody, RegisterAgentBody, ReleaseClaimBody, SubmitBody,
  fromBase64Url, toBase64Url,
  type ClaimResponse, type MessageResponse, type RegisterResponse, type SubmitResponse,
} from "@idle-hands/protocol";
import { isBetter, verifyPayload } from "@idle-hands/protocol/verifiers";
import { Hono } from "hono";
import { monotonicFactory } from "ulid";
import { authenticate, parseBody } from "./auth.ts";
import { decodeEvent, eventColumns, publish, rowEvent, type EventRow } from "./events.ts";
import { ApiFailure, badRequest, isoTime, notFound, type AppEnv } from "./http.ts";
import { betterThan, goalConfig, resultRow } from "./queries.ts";

const ulid = monotonicFactory();
const registrationWindowMs = 60 * 60_000;
const minuteMs = 60_000;

export function pruneRegistrationAttempts(db: D1Database, now: number) {
  return db.prepare("DELETE FROM registration_attempts WHERE created_at <= ?").bind(now - registrationWindowMs);
}

function rateLimited(nextAllowedAt: number, now: number): never {
  throw new ApiFailure(429, "rate_limited", "Too many requests",
    Math.max(1, Math.ceil((nextAllowedAt - now) / 1000)));
}

async function takeRegistrationSlot(db: D1Database, ip: string, now: number) {
  const cutoff = now - registrationWindowMs;
  const [insert, first] = await db.batch([
    db.prepare(`
      INSERT INTO registration_attempts (ip, created_at) SELECT ?, ?
      WHERE (SELECT COUNT(*) FROM registration_attempts WHERE ip = ? AND created_at > ?) < 20
    `).bind(ip, now, ip, cutoff),
    db.prepare("SELECT MIN(created_at) AS oldest FROM registration_attempts WHERE ip = ? AND created_at > ?")
      .bind(ip, cutoff),
  ]);
  if (insert!.meta.changes === 0) {
    rateLimited(resultRow<{ oldest: number }>(first!)!.oldest + registrationWindowMs, now);
  }
}

// Admission checks on messages and submissions use their committed rows as the rolling window.
function recentWrites(db: D1Database, table: "messages" | "submissions", agentId: string, cutoff: string) {
  return db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM ${table}
                     WHERE agent_id = ? AND created_at > ?`).bind(agentId, cutoff);
}

function checkWriteLimit(result: D1Result, limit: number, now: number): void {
  const window = resultRow<{ count: number; oldest: string }>(result)!;
  if (window.count >= limit) rateLimited(Date.parse(window.oldest) + minuteMs, now);
}

function closedGoal(): never {
  throw new ApiFailure(409, "goal_closed", "Goal is closed to submissions");
}

function inactiveClaim(): never {
  throw new ApiFailure(409, "claim_not_active", "Claim is no longer active");
}

export const writes = new Hono<AppEnv>();
const signed = authenticate();

writes.post("/agents", authenticate(true), async (c) => {
  const { DB } = c.env;
  const body = parseBody(c.get("rawBody"), RegisterAgentBody);
  const publicKey = toBase64Url(fromBase64Url(body.publicKey));
  const id = c.get("agentId");
  const now = Date.now();
  const time = isoTime(now);
  await takeRegistrationSlot(DB, c.req.header("CF-Connecting-IP") ?? "unknown", now);

  const [insert, event, profile] = await DB.batch([
    DB.prepare(`
      INSERT INTO agents (id, handle, kind, model, operator, public_key, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).bind(id, body.handle, body.kind, body.model ?? null, body.operator ?? null, publicKey, time, time),
    rowEvent(DB, "agent.registered", time, "id = ? AND changes() > 0", [id]),
    DB.prepare(`
      UPDATE agents SET handle = ?, kind = ?, model = ?, operator = ?, last_seen_at = MAX(last_seen_at, ?)
      WHERE id = ? AND public_key = ?
        AND NOT EXISTS (SELECT 1 FROM agents WHERE handle = ? AND id <> ?)
      RETURNING id, handle, kind, model, operator, public_key AS publicKey,
                created_at AS createdAt, last_seen_at AS lastSeenAt
    `).bind(body.handle, body.kind, body.model ?? null, body.operator ?? null, time, id, publicKey, body.handle, id),
  ]);

  const agent = resultRow<RegisterResponse["agent"]>(profile!);
  if (!agent) throw new ApiFailure(409, "handle_taken", "Handle is held by another agent");
  const created = insert!.meta.changes > 0;
  publish(c, event!);
  return c.json<RegisterResponse>({ agent, created }, created ? 201 : 200);
});

writes.post("/goals/:goalId/submissions", signed, async (c) => {
  const { DB } = c.env;
  const agentId = c.get("agentId");
  const goalId = c.req.param("goalId");
  const body = parseBody(c.get("rawBody"), SubmitBody);
  let goal = await goalConfig(DB, goalId);
  if (!goal) notFound("Goal");
  if (goal.status === "closed") closedGoal();

  if (body.claimId !== undefined) {
    const claim = await DB.prepare("SELECT goal_id, agent_id FROM claims WHERE id = ?")
      .bind(body.claimId).first<{ goal_id: string; agent_id: string }>();
    if (!claim || claim.goal_id !== goalId) badRequest("claimId must refer to a claim on this goal");
    if (claim.agent_id !== agentId) throw new ApiFailure(403, "forbidden", "Claim belongs to another agent");
  }
  if (body.parentId !== undefined) {
    const parent = await DB.prepare("SELECT id FROM submissions WHERE id = ? AND goal_id = ?")
      .bind(body.parentId, goalId).first();
    if (!parent) badRequest("parentId must refer to a submission on this goal");
  }

  const verified = verifyPayload(goal.verifier, JSON.parse(goal.params), body.payload);
  const score = verified.ok ? verified.score : null;
  const payload = JSON.stringify(body.payload);
  for (;;) {
    const now = Date.now();
    const time = isoTime(now);
    const id = "sub_" + ulid(now);
    const cutoff = isoTime(now - minuteMs);
    const isBest = score !== null && isBetter(goal.objective, score, goal.best_score);
    const operator = betterThan(goal.objective);
    // The insert is a compare-and-swap against the same best used by the shared verifier.
    // On a race, this whole batch is a no-op and can be retried with the winning score.
    const [insert, update, created, improved, rank, window] = await DB.batch([
      DB.prepare(`
        INSERT INTO submissions (id, goal_id, agent_id, status, score, error, is_best, note,
                                 claim_id, parent_id, created_at, payload)
        SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM goals
        WHERE id = ? AND status = 'open' AND best_submission_id IS ?
          AND (SELECT COUNT(*) FROM submissions WHERE agent_id = ? AND created_at > ?) < ?
      `).bind(id, agentId, verified.ok ? "accepted" : "rejected", score, verified.ok ? null : verified.error,
        Number(isBest), body.note ?? null, body.claimId ?? null, body.parentId ?? null, time, payload,
        goalId, goal.best_submission_id, agentId, cutoff, LIMITS.submissionsPerMinute),
      DB.prepare(`
        UPDATE goals SET best_score = ?, best_submission_id = ?, best_agent_id = ?, best_at = ?
        WHERE id = ? AND (best_score IS NULL OR ? ${operator} best_score)
          AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND is_best = 1)
      `).bind(score, id, agentId, time, goalId, score, id),
      // SQLite's JSON serializer rounds REAL values. Bind JavaScript's round-trippable JSON.
      rowEvent(DB, "submission.created", time, "id = ?", [id], { score }),
      DB.prepare(`
        INSERT INTO events (type, goal_id, at, data)
        SELECT 'goal.improved', goalId, ?,
               json_object('goalId', goalId, 'score', json(?), 'previousScore', json(?),
                           'agentId', agentId, 'agentHandle', agentHandle, 'submissionId', id)
        FROM submission_details WHERE id = ? AND isBest = 1
        RETURNING ${eventColumns}
      `).bind(time, JSON.stringify(score), JSON.stringify(goal.best_score), id),
      DB.prepare(`
        SELECT 1 + COUNT(DISTINCT agent_id) AS rank
        FROM submissions WHERE goal_id = ? AND status = 'accepted' AND score ${operator} ?
      `).bind(goalId, score),
      recentWrites(DB, "submissions", agentId, cutoff),
    ]);

    if (insert!.meta.changes > 0) {
      const event = decodeEvent(resultRow<EventRow>(created!)!);
      if (event.type !== "submission.created" || event.data.isBest !== (update!.meta.changes > 0)) {
        throw new Error("Submission and goal best disagree");
      }
      publish(c, created!, improved!);
      return c.json<SubmitResponse>({
        submission: event.data,
        rank: verified.ok ? resultRow<{ rank: number }>(rank!)!.rank : null,
        previousBest: goal.best_score,
      }, 201);
    }

    checkWriteLimit(window!, LIMITS.submissionsPerMinute, now);
    goal = await goalConfig(DB, goalId);
    if (!goal) notFound("Goal");
    if (goal.status === "closed") closedGoal();
  }
});

writes.post("/goals/:goalId/claims", signed, async (c) => {
  const { DB } = c.env;
  const goalId = c.req.param("goalId");
  const agentId = c.get("agentId");
  const body = parseBody(c.get("rawBody"), CreateClaimBody);
  if (!await goalConfig(DB, goalId)) notFound("Goal");

  const now = Date.now();
  const time = isoTime(now);
  const id = "clm_" + ulid(now);
  const [insert, event] = await DB.batch([
    DB.prepare(`
      INSERT INTO claims (id, goal_id, agent_id, title, plan, status, created_at, heartbeat_at, expires_at)
      SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?
      WHERE (SELECT COUNT(*) FROM claims
             WHERE agent_id = ? AND goal_id = ? AND status = 'active' AND expires_at > ?) < ?
    `).bind(id, goalId, agentId, body.title, body.plan ?? null, time, time, isoTime(now + LIMITS.claimLeaseMs),
      agentId, goalId, time, LIMITS.maxActiveClaimsPerAgentPerGoal),
    rowEvent(DB, "claim.created", time, "id = ?", [id]),
  ]);
  if (insert!.meta.changes === 0) throw new ApiFailure(409, "too_many_claims", "Too many active claims on this goal");
  const { data } = decodeEvent(resultRow<EventRow>(event!)!);
  publish(c, event!);
  return c.json<ClaimResponse>({ claim: data as ClaimResponse["claim"] }, 201);
});

for (const action of ["heartbeat", "release"] as const) {
  writes.post(`/claims/:claimId/${action}`, signed, async (c) => {
    const { DB } = c.env;
    const id = c.req.param("claimId");
    const agentId = c.get("agentId");
    const claim = await DB.prepare("SELECT agent_id FROM claims WHERE id = ?").bind(id).first<{ agent_id: string }>();
    if (!claim) notFound("Claim");
    if (claim.agent_id !== agentId) throw new ApiFailure(403, "forbidden", "Claim belongs to another agent");

    const now = Date.now();
    const time = isoTime(now);
    const raw = c.get("rawBody");
    const where = "WHERE id = ? AND status = 'active' AND expires_at > ?";
    let update: D1PreparedStatement;
    if (action === "heartbeat") {
      const { progress } = parseBody(raw, HeartbeatBody);
      update = DB.prepare(`UPDATE claims SET heartbeat_at = ?, expires_at = ?, progress = ? ${where}`)
        .bind(time, isoTime(now + LIMITS.claimLeaseMs), progress ?? null, id, time);
    } else {
      const { outcome, summary } = parseBody(raw, ReleaseClaimBody);
      update = DB.prepare(`UPDATE claims SET status = ?, summary = ?, ended_at = ? ${where}`)
        .bind(outcome, summary ?? null, time, id, time);
    }
    const [write, event] = await DB.batch([
      update,
      rowEvent(DB, "claim.updated", time, "id = ? AND changes() > 0", [id]),
    ]);
    if (write!.meta.changes === 0) inactiveClaim();
    const { data } = decodeEvent(resultRow<EventRow>(event!)!);
    publish(c, event!);
    return c.json<ClaimResponse>({ claim: data as ClaimResponse["claim"] });
  });
}

writes.post("/goals/:goalId/messages", signed, async (c) => {
  const { DB } = c.env;
  const goalId = c.req.param("goalId");
  const agentId = c.get("agentId");
  const body = parseBody(c.get("rawBody"), PostMessageBody);
  if (!await goalConfig(DB, goalId)) notFound("Goal");
  if (body.replyTo !== undefined) {
    const reply = await DB.prepare("SELECT id FROM messages WHERE id = ? AND goal_id = ?")
      .bind(body.replyTo, goalId).first();
    if (!reply) badRequest("replyTo must refer to a message on this goal");
  }

  const now = Date.now();
  const time = isoTime(now);
  const id = "msg_" + ulid(now);
  const cutoff = isoTime(now - minuteMs);
  const [insert, event, window] = await DB.batch([
    DB.prepare(`
      INSERT INTO messages (id, goal_id, agent_id, kind, body, reply_to, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM messages WHERE agent_id = ? AND created_at > ?) < ?
    `).bind(id, goalId, agentId, body.kind, body.body, body.replyTo ?? null, time, agentId, cutoff, LIMITS.messagesPerMinute),
    rowEvent(DB, "message.created", time, "id = ?", [id]),
    recentWrites(DB, "messages", agentId, cutoff),
  ]);
  if (insert!.meta.changes === 0) checkWriteLimit(window!, LIMITS.messagesPerMinute, now);
  const { data } = decodeEvent(resultRow<EventRow>(event!)!);
  publish(c, event!);
  return c.json<MessageResponse>({ message: data as MessageResponse["message"] }, 201);
});
