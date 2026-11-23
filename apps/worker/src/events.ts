import { LIMITS, type EventType, type FeedEvent } from "@idle-hands/protocol";
import type { AppContext, WorkerBindings } from "./http.ts";

export interface EventRow {
  seq: number;
  type: EventType;
  goalId: string | null;
  at: string;
  data: string;
}

export const eventColumns = "seq, type, goal_id AS goalId, at, data";

export function decodeEvent(row: EventRow): FeedEvent {
  return { ...row, data: JSON.parse(row.data) } as FeedEvent;
}

export async function latestSequence(db: D1Database): Promise<number> {
  return await db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").first<number>("seq") ?? 0;
}

export function liveHub(env: WorkerBindings) {
  return env.LIVE.get(env.LIVE.idFromName("global"));
}

export function broadcast(env: WorkerBindings, ctx: Pick<ExecutionContext, "waitUntil">, results: D1Result[]) {
  const events = results.flatMap(({ results }) => (results as EventRow[]).map(decodeEvent));
  if (events.length === 0) return;
  ctx.waitUntil(liveHub(env).publish(events).catch((error) => console.error("LiveHub publish failed", error)));
}

export function publish(c: AppContext, ...results: D1Result[]) {
  broadcast(c.env, c.executionCtx, results);
}

// Build the outbox event from the stored row, inside the same D1 transaction.
const eventSources = {
  "agent.registered": {
    view: "agent_profiles",
    goal: "NULL",
    fields: "id handle kind model operator publicKey createdAt lastSeenAt",
  },
  "submission.created": {
    view: "submission_details",
    goal: "goalId",
    fields: "id goalId agentId agentHandle status score error isBest note claimId parentId createdAt",
  },
  "claim.created": {
    view: "claim_details",
    goal: "goalId",
    fields: "id goalId agentId agentHandle title plan status progress summary createdAt heartbeatAt expiresAt endedAt",
  },
  "message.created": {
    view: "message_details",
    goal: "goalId",
    fields: "id goalId agentId agentHandle kind body replyTo createdAt",
  },
};
type RowEventType = keyof typeof eventSources | "claim.updated";

export function rowEvent(
  db: D1Database,
  type: RowEventType,
  at: string,
  where: string,
  bindings: string[],
  overrides: Record<string, string | number | null> = {},
) {
  const source = eventSources[type === "claim.updated" ? "claim.created" : type];
  const jsonBindings: string[] = [];
  const fields = source.fields.split(" ").map((field) => {
    if (Object.hasOwn(overrides, field)) {
      jsonBindings.push(JSON.stringify(overrides[field]));
      return `'${field}', json(?)`;
    }
    const expression = field === "isBest" ? "json(CASE isBest WHEN 1 THEN 'true' ELSE 'false' END)" : field;
    return `'${field}', ${expression}`;
  });
  return db.prepare(`
    INSERT INTO events (type, goal_id, at, data)
    SELECT ?, ${source.goal}, ?, json_object(${fields.join(", ")})
    FROM ${source.view}
    WHERE ${where}
    RETURNING ${eventColumns}
  `).bind(type, at, ...jsonBindings, ...bindings);
}

export async function eventsBetween(db: D1Database, after: number, through: number) {
  const { results } = await db.prepare(`
    SELECT ${eventColumns} FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?
  `).bind(after, through, LIMITS.maxPageSize).all<EventRow>();
  return results.map(decodeEvent);
}
