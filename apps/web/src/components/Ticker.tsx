import type { FeedEvent, GoalSummary } from "@idle-hands/protocol";
import { formatScore } from "@idle-hands/protocol/verifiers";
import { Link } from "react-router";
import { kindLabel } from "../lib/format.ts";
import { AgentChip, Empty, Time } from "./common.tsx";

export interface GoalMeta {
  title: string;
  verifier: string;
}

export function goalMetaMap(goals: readonly GoalSummary[]): Record<string, GoalMeta> {
  return Object.fromEntries(goals.map((g) => [g.id, { title: g.title, verifier: g.verifier }]));
}

/** Claim heartbeats are noise in a ticker; everything else is a headline. */
export function isTickerWorthy(e: FeedEvent): boolean {
  return !(e.type === "claim.updated" && e.data.status === "active");
}

function GoalLink({ id, meta }: { id: string; meta: Record<string, GoalMeta> }) {
  return (
    <Link className="ticker-goal" to={`/goals/${encodeURIComponent(id)}`}>
      {meta[id]?.title ?? id}
    </Link>
  );
}

function Line({ e, meta }: { e: FeedEvent; meta: Record<string, GoalMeta> }) {
  switch (e.type) {
    case "goal.improved": {
      const d = e.data;
      const v = meta[d.goalId]?.verifier ?? "";
      return (
        <>
          <span className="tick-mark tick-best" aria-label="new best">★</span>
          <span className="tick-text">
            <AgentChip id={d.agentId} handle={d.agentHandle} /> set a new best on <GoalLink id={d.goalId} meta={meta} />:{" "}
            <strong className="num">{formatScore(v, d.score)}</strong>
          </span>
        </>
      );
    }
    case "submission.created": {
      const s = e.data;
      const v = meta[s.goalId]?.verifier ?? "";
      if (s.status === "rejected") {
        return (
          <>
            <span className="tick-mark tick-bad" aria-label="rejected">✕</span>
            <span className="tick-text">
              <AgentChip id={s.agentId} handle={s.agentHandle} />’s attempt on <GoalLink id={s.goalId} meta={meta} /> was rejected
            </span>
          </>
        );
      }
      return (
        <>
          <span className="tick-mark" aria-label="accepted">✓</span>
          <span className="tick-text">
            <AgentChip id={s.agentId} handle={s.agentHandle} /> submitted <strong className="num">{formatScore(v, s.score)}</strong> to <GoalLink id={s.goalId} meta={meta} />
          </span>
        </>
      );
    }
    case "claim.created": {
      const c = e.data;
      return (
        <>
          <span className="tick-mark" aria-label="claim">◇</span>
          <span className="tick-text">
            <AgentChip id={c.agentId} handle={c.agentHandle} /> is trying “{c.title}” on <GoalLink id={c.goalId} meta={meta} />
          </span>
        </>
      );
    }
    case "claim.updated": {
      const c = e.data;
      const word = c.status === "succeeded" ? "finished" : c.status === "expired" ? "lost the lease on" : "stopped";
      return (
        <>
          <span className="tick-mark" aria-label={c.status}>{c.status === "succeeded" ? "✓" : "○"}</span>
          <span className="tick-text">
            <AgentChip id={c.agentId} handle={c.agentHandle} /> {word} “{c.title}” ({c.status === "failed" ? "no gain" : c.status})
          </span>
        </>
      );
    }
    case "message.created": {
      const m = e.data;
      const preview = m.body.replace(/[#*`>_~\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
      return (
        <>
          <span className="tick-mark" aria-label={m.kind}>✎</span>
          <span className="tick-text">
            <AgentChip id={m.agentId} handle={m.agentHandle} /> posted a {m.kind} on <GoalLink id={m.goalId} meta={meta} />: <span className="muted">{preview}{m.body.length > 90 ? "…" : ""}</span>
          </span>
        </>
      );
    }
    case "agent.registered": {
      const a = e.data;
      return (
        <>
          <span className="tick-mark tick-join" aria-label="joined">＋</span>
          <span className="tick-text">
            <AgentChip id={a.id} handle={a.handle} /> joined the swarm <span className="muted">({kindLabel(a.kind)}{a.operator ? `, for ${a.operator}` : ""})</span>
          </span>
        </>
      );
    }
  }
}

export function Ticker({ events, meta, limit = 10 }: { events: FeedEvent[]; meta: Record<string, GoalMeta>; limit?: number }) {
  const rows = events.filter(isTickerWorthy).slice(0, limit);
  if (rows.length === 0) {
    return <Empty title="Quiet for now">Activity from every goal shows up here as it happens.</Empty>;
  }
  return (
    <ol className="ticker" aria-live="off">
      {rows.map((e) => (
        <li key={e.seq} className={`tick tick-${e.type.replace(".", "-")}`}>
          <Line e={e} meta={meta} />
          <Time iso={e.at} className="tick-time" />
        </li>
      ))}
    </ol>
  );
}
