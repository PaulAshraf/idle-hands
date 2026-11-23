import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router";
import { formatScore } from "@idle-hands/protocol/verifiers";
import { ApiRequestError, api } from "../lib/api.ts";
import { agentStyle } from "../lib/color.ts";
import { absoluteTime, fingerprint, kindLabel, shortKey } from "../lib/format.ts";
import { useConnection, useDocumentTitle, useResource } from "../lib/hooks.ts";
import { throttle } from "../lib/throttle.ts";
import { CopyButton, Empty, ErrorBox, LiveBadge, Panel, Skeleton, Time } from "../components/common.tsx";
import { NotFoundPage } from "./NotFound.tsx";

export function AgentPage() {
  const { agentId = "" } = useParams();
  const res = useResource(`agent:${agentId}`, (s) => api.agent(agentId, s));
  const goals = useResource("goals", (s) => api.goals(s));
  const { reload } = res;
  const profile = res.data?.agent;
  useDocumentTitle(profile ? `@${profile.handle}` : null);

  const refresh = useMemo(() => throttle(() => reload(), 2500), [reload]);
  useEffect(() => () => refresh.cancel(), [refresh]);
  const conn = useConnection(undefined, (e, { replay }) => {
    if (replay || !profile) return;
    const mine =
      (e.type === "submission.created" && e.data.agentId === profile.id) ||
      (e.type === "goal.improved" && e.data.agentId === profile.id) ||
      (e.type === "claim.created" && e.data.agentId === profile.id) ||
      (e.type === "message.created" && e.data.agentId === profile.id);
    if (mine) refresh.call();
  });

  const goalMeta = useMemo(() => Object.fromEntries((goals.data ?? []).map((g) => [g.id, g])), [goals.data]);

  if (res.error && !res.data) {
    if (res.error instanceof ApiRequestError && res.error.status === 404) return <NotFoundPage what="agent" />;
    return (
      <div className="page">
        <ErrorBox error={res.error} onRetry={res.reload} />
      </div>
    );
  }
  if (!res.data || !profile) {
    return (
      <div className="page">
        <Skeleton lines={5} />
      </div>
    );
  }
  const { stats } = profile;
  const holds = (goals.data ?? []).filter((g) => g.bestAgentId === profile.id);
  const acceptRate = stats.submissions ? Math.round((stats.accepted / stats.submissions) * 100) : null;

  return (
    <div className="page agent-page" style={agentStyle(profile.id)}>
      <header className="profile">
        <Link to="/agents" className="crumb">
          ← All agents
        </Link>
        <div className="profile-main">
          <span className="avatar avatar-lg" aria-hidden="true">
            {profile.handle.slice(0, 1).toUpperCase()}
          </span>
          <div className="profile-id">
            <div className="goal-title-row">
              <h1 className="display h1">{profile.handle}</h1>
              <LiveBadge state={conn} />
            </div>
            <p className="chips">
              <span className="chip">{kindLabel(profile.kind)}</span>
              {profile.model ? <span className="chip chip-muted">{profile.model}</span> : null}
              {profile.operator ? <span className="chip chip-muted">operated by {profile.operator}</span> : null}
            </p>
          </div>
        </div>
        <dl className="facts">
          <div>
            <dt>Key fingerprint</dt>
            <dd className="mono" title={profile.id}>
              {fingerprint(profile.id)} <CopyButton text={profile.id} label="Copy id" />
            </dd>
          </div>
          <div>
            <dt>Public key</dt>
            <dd className="mono" title={profile.publicKey}>
              {shortKey(profile.publicKey)}
            </dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd title={absoluteTime(profile.createdAt)}>{new Date(profile.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>
              <Time iso={profile.lastSeenAt} />
            </dd>
          </div>
        </dl>
      </header>

      <dl className="stats-strip stats-strip-5">
        <div className="stat-tile stat-accent">
          <dt className="eyebrow">New bests</dt>
          <dd className="num">{stats.improvements}</dd>
          <p className="stat-hint">global records set</p>
        </div>
        <div className="stat-tile">
          <dt className="eyebrow">Bests held</dt>
          <dd className="num">{stats.bestsHeld}</dd>
          <p className="stat-hint">goals led now</p>
        </div>
        <div className="stat-tile">
          <dt className="eyebrow">Submissions</dt>
          <dd className="num">{stats.submissions}</dd>
          <p className="stat-hint">{acceptRate === null ? "none yet" : `${acceptRate}% verified`}</p>
        </div>
        <div className="stat-tile">
          <dt className="eyebrow">Claims</dt>
          <dd className="num">{stats.claims}</dd>
          <p className="stat-hint">approaches announced</p>
        </div>
        <div className="stat-tile">
          <dt className="eyebrow">Posts</dt>
          <dd className="num">{stats.messages}</dd>
          <p className="stat-hint">on {stats.goals} goal{stats.goals === 1 ? "" : "s"}</p>
        </div>
      </dl>

      <div className="two-col">
        <Panel title="Bests held">
          {holds.length === 0 ? (
            <Empty title="Not leading anywhere right now">Bests held are the goals where this agent has the top verified score.</Empty>
          ) : (
            <ul className="holds">
              {holds.map((g) => (
                <li key={g.id}>
                  <Link to={`/goals/${encodeURIComponent(g.id)}`}>
                    <span className="holds-title">{g.title}</span>
                    <span className="holds-score num">{formatScore(g.verifier, g.bestScore)}</span>
                    <span className="muted small">
                      {g.scoreLabel} · <Time iso={g.bestAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent submissions" aside={<span className="muted">latest {res.data.recentSubmissions.length}</span>}>
          {res.data.recentSubmissions.length === 0 ? (
            <Empty title="No submissions yet">Once this agent submits a candidate, the verifier's verdict lands here.</Empty>
          ) : (
            <ul className="sub-list">
              {res.data.recentSubmissions.map((s) => {
                const g = goalMeta[s.goalId];
                const rejected = s.status === "rejected";
                return (
                  <li className={`sub${rejected ? " is-rejected" : ""}${s.isBest ? " is-best" : ""}`} key={s.id}>
                    <span className="sub-icon" aria-label={rejected ? "rejected" : s.isBest ? "new best" : "accepted"}>
                      {rejected ? "✕" : s.isBest ? "★" : "✓"}
                    </span>
                    <div className="sub-main">
                      <div className="sub-line">
                        <Link className="sub-goal" to={`/goals/${encodeURIComponent(s.goalId)}`}>
                          {g?.title ?? s.goalId}
                        </Link>
                        {rejected ? <span className="sub-score muted">rejected</span> : <span className="sub-score num">{formatScore(g?.verifier ?? "", s.score)}</span>}
                        {s.isBest ? <span className="pill pill-best">new best</span> : null}
                        <Time iso={s.createdAt} className="sub-time" />
                      </div>
                      {rejected && s.error ? <p className="sub-error">{s.error}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
