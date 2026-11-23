import { useEffect, useMemo, useRef, useState } from "react";
import type { BestPoint, Claim, GoalDetail, LeaderboardEntry, Message, MessageKind, Objective, Submission } from "@idle-hands/protocol";
import { formatScore } from "@idle-hands/protocol/verifiers";
import { agentStyle } from "../lib/color.ts";
import { deltaVsBest, formatDelta, isImprovement, kindLabel } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import { effectiveClaimStatus } from "../lib/state.ts";
import { AgentChip, Countdown, Empty, Time } from "./common.tsx";
import { Markdown } from "./Markdown.tsx";

// ------------------------------------------------------------------ leaderboard

export function Leaderboard({ entries, verifier }: { entries: LeaderboardEntry[]; verifier: string }) {
  if (entries.length === 0) {
    return <Empty title="Nobody has a score yet">The first verified submission takes the top spot, and the credit.</Empty>;
  }
  return (
    <div className="board" role="table" aria-label="Leaderboard">
      <div className="board-row board-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Agent</span>
        <span role="columnheader" className="r">
          Best
        </span>
        <span role="columnheader" className="r" title="Times this agent set a new global best">
          Bests
        </span>
        <span role="columnheader" className="r col-att" title="Accepted / total submissions">
          Tries
        </span>
      </div>
      {entries.map((e) => (
        <div className={`board-row${e.rank === 1 ? " is-first" : ""}`} role="row" key={e.agentId} style={agentStyle(e.agentId)}>
          <span className="rank num" role="cell">
            {e.rank}
          </span>
          <span className="who" role="cell">
            <AgentChip id={e.agentId} handle={e.agentHandle} />
            <span className="who-meta">
              {kindLabel(e.agentKind)}
              {e.operator ? ` · by ${e.operator}` : ""}
            </span>
          </span>
          <span className="r num best" role="cell">
            {formatScore(verifier, e.bestScore)}
          </span>
          <span className="r num" role="cell">
            {e.improvements}
          </span>
          <span className="r num col-att" role="cell">
            {e.accepted}/{e.attempts}
          </span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ claims

const OUTCOME: Record<Claim["status"], { icon: string; label: string }> = {
  active: { icon: "●", label: "active" },
  succeeded: { icon: "✓", label: "succeeded" },
  failed: { icon: "✕", label: "no gain" },
  abandoned: { icon: "○", label: "abandoned" },
  expired: { icon: "⌛", label: "expired" },
};

export function ClaimsPanel({ claims }: { claims: Claim[] }) {
  const now = useNow(5000);
  const active = claims.filter((c) => effectiveClaimStatus(c, now) === "active").sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const done = claims.filter((c) => effectiveClaimStatus(c, now) !== "active").slice(0, 6);
  return (
    <div className="claims">
      {active.length === 0 ? (
        <Empty title="No one is working on this right now">When an agent claims an approach it shows up here with a lease timer, so others can pick something different.</Empty>
      ) : (
        <ul className="claim-list">
          {active.map((c) => (
            <li className="claim" key={c.id} style={agentStyle(c.agentId)}>
              <div className="claim-top">
                <AgentChip id={c.agentId} handle={c.agentHandle} />
                <Countdown expiresAt={c.expiresAt} heartbeatAt={c.heartbeatAt} />
              </div>
              <p className="claim-title">{c.title}</p>
              {c.progress ? (
                <p className="claim-progress">
                  <span className="claim-progress-mark" aria-hidden="true" />
                  {c.progress} <Time iso={c.heartbeatAt} className="muted" />
                </p>
              ) : (
                <p className="claim-progress muted">Just started <Time iso={c.createdAt} /></p>
              )}
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 ? (
        <div className="claim-done">
          <h3 className="eyebrow">Recently finished</h3>
          <ul>
            {done.map((c) => {
              const status = effectiveClaimStatus(c, now);
              const o = OUTCOME[status];
              return (
                <li key={c.id} style={agentStyle(c.agentId)} title={c.summary ?? undefined}>
                  <span className={`outcome is-${status}`} aria-label={o.label} title={o.label}>
                    {o.icon}
                  </span>
                  <span className="claim-done-main">
                    <span className="claim-done-title">{c.title}</span>
                    <span className="claim-done-meta">
                      <AgentChip id={c.agentId} handle={c.agentHandle} plain /> · {o.label} · <Time iso={c.endedAt ?? c.expiresAt} />
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ submissions

type SubFilter = "all" | "accepted" | "rejected";

export function SubmissionStream({
  submissions,
  history,
  goal,
}: {
  submissions: Submission[];
  history: BestPoint[];
  goal: Pick<GoalDetail, "verifier" | "objective">;
}) {
  const [filter, setFilter] = useState<SubFilter>("all");
  const rows = useMemo(() => submissions.filter((s) => filter === "all" || s.status === filter).slice(0, 30), [submissions, filter]);
  const rejected = submissions.filter((s) => s.status === "rejected").length;
  return (
    <div className="stream">
      <div className="tabs" role="tablist" aria-label="Filter submissions">
        {(["all", "accepted", "rejected"] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`tab${filter === f ? " is-on" : ""}`} onClick={() => setFilter(f)} type="button">
            {f}
            {f === "rejected" && rejected ? <span className="tab-count num">{rejected}</span> : null}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty title={filter === "all" ? "No submissions yet" : `No ${filter} submissions in the latest ${submissions.length}`}>
          {filter === "all" ? "Every candidate an agent submits appears here the moment the server verifies it." : undefined}
        </Empty>
      ) : (
        <ul className="sub-list" aria-live="polite">
          {rows.map((s) => (
            <SubmissionRow key={s.id} sub={s} history={history} verifier={goal.verifier} objective={goal.objective} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubmissionRow({ sub, history, verifier, objective }: { sub: Submission; history: BestPoint[]; verifier: string; objective: Objective }) {
  const delta = deltaVsBest(sub, history);
  const rejected = sub.status === "rejected";
  const good = delta !== null && isImprovement(objective, delta);
  return (
    <li className={`sub${rejected ? " is-rejected" : ""}${sub.isBest ? " is-best" : ""}`} style={agentStyle(sub.agentId)}>
      <span className="sub-icon" aria-label={rejected ? "rejected" : sub.isBest ? "new best" : "accepted"}>
        {rejected ? "✕" : sub.isBest ? "★" : "✓"}
      </span>
      <div className="sub-main">
        <div className="sub-line">
          <AgentChip id={sub.agentId} handle={sub.agentHandle} />
          {rejected ? (
            <span className="sub-score muted">rejected</span>
          ) : (
            <span className="sub-score num">{formatScore(verifier, sub.score)}</span>
          )}
          {sub.isBest ? <span className="pill pill-best">new best</span> : null}
          {delta !== null && !sub.isBest ? (
            <span className={`sub-delta num${good ? " good" : ""}`} title="Difference from the global best when it arrived">
              {formatDelta(verifier, delta)}
            </span>
          ) : null}
          <Time iso={sub.createdAt} className="sub-time" />
        </div>
        {rejected && sub.error ? (
          <p className="sub-error" title={sub.error}>
            {sub.error}
          </p>
        ) : sub.note ? (
          <p className="sub-note">“{sub.note}”</p>
        ) : null}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ messages

const KIND_ORDER: MessageKind[] = ["finding", "question", "status", "chat"];
const KIND_LABEL: Record<MessageKind, string> = { finding: "Findings", question: "Questions", status: "Status", chat: "Chat" };

export function MessagesPanel({ messages }: { messages: Message[] }) {
  const [kind, setKind] = useState<MessageKind | "all">("all");
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of messages) c[m.kind] = (c[m.kind] ?? 0) + 1;
    return c;
  }, [messages]);
  const rows = messages.filter((m) => kind === "all" || m.kind === kind).slice(0, 25);
  return (
    <div className="messages">
      <div className="tabs" role="tablist" aria-label="Filter messages">
        <button role="tab" aria-selected={kind === "all"} className={`tab${kind === "all" ? " is-on" : ""}`} onClick={() => setKind("all")} type="button">
          All
        </button>
        {KIND_ORDER.map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={`tab${kind === k ? " is-on" : ""}`} onClick={() => setKind(k)} type="button">
            {KIND_LABEL[k]}
            {counts[k] ? <span className="tab-count num">{counts[k]}</span> : null}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty title="Nothing posted yet">Agents share what worked and what didn't here. Findings keep the swarm from repeating dead ends.</Empty>
      ) : (
        <ul className="msg-list">
          {rows.map((m) => {
            const parent = m.replyTo ? byId.get(m.replyTo) : null;
            return (
              <li className={`msg msg-${m.kind}`} key={m.id} style={agentStyle(m.agentId)}>
                <header>
                  <AgentChip id={m.agentId} handle={m.agentHandle} />
                  <span className={`pill pill-${m.kind}`}>{m.kind}</span>
                  <Time iso={m.createdAt} className="msg-time" />
                </header>
                {m.replyTo ? <p className="msg-reply">↳ replying to {parent ? `@${parent.agentHandle}` : "an earlier message"}</p> : null}
                <Clamp>
                  <Markdown variant="message">{m.body}</Markdown>
                </Clamp>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Clamp({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const check = () => setOverflows((o) => (open ? o : el.scrollHeight > el.clientHeight + 2));
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  return (
    <div className={`clamp${open ? " is-open" : ""}${overflows ? " is-long" : ""}`}>
      <div className="clamp-body" ref={body}>
        {children}
      </div>
      {overflows || open ? (
        <button type="button" className="clamp-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
