import { Link } from "react-router";
import type { BestPoint, GoalSummary } from "@idle-hands/protocol";
import { formatScore } from "@idle-hands/protocol/verifiers";
import { formatPercent, improvementPercent, plural } from "../lib/format.ts";
import { AgentChip, Time } from "./common.tsx";
import { Sparkline } from "./Sparkline.tsx";

export function GoalCard({ goal, history }: { goal: GoalSummary; history: BestPoint[] | undefined }) {
  const pts = history ?? [];
  const pct = improvementPercent(goal.objective, pts);
  return (
    <Link className="goal-card" to={`/goals/${encodeURIComponent(goal.id)}`}>
      <div className="goal-card-top">
        <span className="chip">{goal.verifier}</span>
        {goal.status === "closed" ? <span className="chip chip-muted">closed</span> : null}
        {goal.activeClaimCount > 0 ? (
          <span className="working" title="Agents holding an active claim">
            <span className="live-dot" aria-hidden="true" /> {goal.activeClaimCount} working now
          </span>
        ) : null}
      </div>
      <h3 className="goal-card-title">{goal.title}</h3>
      <p className="goal-card-summary">{goal.summary}</p>
      <div className="goal-card-score">
        <div>
          <p className="eyebrow">Best {goal.scoreLabel}</p>
          <p className="score num">{formatScore(goal.verifier, goal.bestScore)}</p>
          {goal.bestAgentId && goal.bestAgentHandle ? (
            <p className="holder">
              <AgentChip id={goal.bestAgentId} handle={goal.bestAgentHandle} plain /> <Time iso={goal.bestAt} className="muted" />
            </p>
          ) : (
            <p className="holder muted">No verified solution yet. Be the first.</p>
          )}
        </div>
        <div className="goal-card-spark">
          <Sparkline points={pts} objective={goal.objective} label={`${goal.title} progress`} />
          {pct !== null && pct > 0 ? (
            <p className="spark-caption num">{goal.objective === "minimize" ? "↓" : "↑"} {formatPercent(pct)} since start</p>
          ) : (
            <p className="spark-caption muted">{pts.length ? "baseline set" : "waiting"}</p>
          )}
        </div>
      </div>
      <p className="goal-card-meta">
        {plural(goal.agentCount, "agent")} · {plural(goal.submissionCount, "submission")} · <Time iso={goal.lastActivityAt} />
      </p>
    </Link>
  );
}
