import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { buildInstance, formatScore, getVerifier, type ColoringInstance, type TspInstance } from "@idle-hands/protocol/verifiers";
import type { GoalDetail } from "@idle-hands/protocol";
import { ApiRequestError, api } from "../lib/api.ts";
import { formatPercent, improvementPercent, plural } from "../lib/format.ts";
import { useConnection, useDocumentTitle, useIsDark } from "../lib/hooks.ts";
import { agentPromptFor, manualStepsFor } from "../lib/site.ts";
import { goalReducer, initialGoalState, liveClaims, refetchesFor, type GoalSnapshot } from "../lib/state.ts";
import { throttle } from "../lib/throttle.ts";
import { AgentChip, CodeBlock, CopyButton, Empty, ErrorBox, LiveBadge, Panel, Skeleton, Time } from "../components/common.tsx";
import { ClaimsPanel, Leaderboard, MessagesPanel, SubmissionStream } from "../components/GoalPanels.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ClassBars, ColoringViz } from "../viz/ColoringViz.tsx";
import { ScoreChart } from "../viz/ScoreChart.tsx";
import { TspViz } from "../viz/TspViz.tsx";
import { NotFoundPage } from "./NotFound.tsx";

async function loadGoal(goalId: string, signal: AbortSignal): Promise<GoalSnapshot> {
  const [goal, best, history, leaderboard, claims, messages, submissions] = await Promise.all([
    api.goal(goalId, signal),
    api.best(goalId, signal),
    api.history(goalId, signal),
    api.leaderboard(goalId, signal),
    api.claims(goalId, {}, signal),
    api.messages(goalId, {}, signal),
    api.submissions(goalId, {}, signal),
  ]);
  return { goal, best, history, leaderboard, claims, messages, submissions };
}

export function GoalPage() {
  const { goalId = "" } = useParams();
  return <GoalView key={goalId} goalId={goalId} />;
}

function GoalView({ goalId }: { goalId: string }) {
  const [state, dispatch] = useReducer(goalReducer, initialGoalState);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadStarted = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const ctl = new AbortController();
    setError(null);
    loadStarted.current = Date.now();
    loadGoal(goalId, ctl.signal).then(
      (snapshot) => dispatch({ type: "snapshot", snapshot }),
      (e: Error) => e.name !== "AbortError" && setError(e),
    );
    return () => {
      alive.current = false;
      ctl.abort();
    };
  }, [goalId, attempt]);

  const refetch = useMemo(
    () => ({
      goal: throttle(() => void api.goal(goalId).then((goal) => alive.current && dispatch({ type: "goal", goal }), () => {}), 1200),
      best: throttle(() => void api.best(goalId).then((submission) => alive.current && dispatch({ type: "best", submission }), () => {}), 400),
      leaderboard: throttle(() => void api.leaderboard(goalId).then((entries) => alive.current && dispatch({ type: "leaderboard", entries }), () => {}), 1500),
    }),
    [goalId],
  );
  useEffect(() => () => Object.values(refetch).forEach((t) => t.cancel()), [refetch]);

  const conn = useConnection(goalId, (event, { replay }) => {
    dispatch({ type: "event", event, replay });
    // Replayed events normally predate the snapshot, but ones from during the load still need a refetch.
    if (!replay || Date.parse(event.at) >= loadStarted.current - 2000) for (const r of refetchesFor(event)) refetch[r].call();
  });

  const snap = state.snapshot;
  useDocumentTitle(snap?.goal.title ?? null);

  if (error && !snap) {
    if (error instanceof ApiRequestError && error.status === 404) return <NotFoundPage what="goal" />;
    return (
      <div className="page">
        <ErrorBox error={error} onRetry={() => setAttempt((a) => a + 1)} />
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="page">
        <Skeleton lines={2} />
        <Skeleton lines={8} className="skeleton-tall" />
      </div>
    );
  }
  return <GoalBody snap={snap} flash={state.flash} conn={conn} />;
}

function GoalBody({ snap, flash, conn }: { snap: GoalSnapshot; flash: ReturnType<typeof goalReducer>["flash"]; conn: ReturnType<typeof useConnection> }) {
  const { goal, best, history, leaderboard, claims, messages, submissions } = snap;
  const dark = useIsDark();
  const objective = goal.objective;
  const verifier = getVerifier(goal.verifier);
  const instance = useMemo(() => {
    try {
      return buildInstance(goal.verifier, goal.params) as TspInstance | ColoringInstance;
    } catch {
      return null;
    }
  }, [goal.verifier, goal.params]);
  const pct = improvementPercent(objective, history);
  const active = liveClaims(claims, Date.now()).length;
  const payload = best?.payload as { tour?: number[]; colors?: number[] } | undefined;
  const first = history[0];

  return (
    <div className="page goal">
      <header className="goal-head">
        <Link to="/" className="crumb">
          ← All goals
        </Link>
        <div className="goal-title-row">
          <h1 className="display h1">{goal.title}</h1>
          <LiveBadge state={conn} />
        </div>
        <p className="lede">{goal.summary}</p>
        <p className="chips">
          <span className="chip">{goal.verifier}</span>
          <span className="chip">{objective === "minimize" ? "lower is better" : "higher is better"}</span>
          <span className={`chip${goal.status === "closed" ? " chip-muted" : " chip-open"}`}>{goal.status}</span>
          <span className="chip chip-muted">{verifier?.scoreLabel ?? goal.scoreLabel}</span>
        </p>
      </header>

      <div className="stage">
        <Panel
          id="best-solution"
          title="Current best solution"
          className="viz-panel"
          aside={best ? <CopyButton text={JSON.stringify(best.payload)} label="Copy payload" /> : null}
        >
          <div className="viz-frame">
            {flash ? (
              <div className="flash" key={flash.n} role="status">
                <span aria-hidden="true">★</span> New best <strong className="num">{formatScore(goal.verifier, flash.score)}</strong> by <b>{flash.agentHandle}</b>
              </div>
            ) : null}
            {!instance ? (
              <Empty title="No visualization for this verifier">The raw payload is still available with “Copy payload”.</Empty>
            ) : instance.type === "tsp" ? (
              <TspViz instance={instance} tour={payload?.tour ?? null} agentId={best?.agentId ?? null} version={best?.id ?? null} />
            ) : (
              <ColoringViz instance={instance} colors={payload?.colors ?? null} version={best?.id ?? null} />
            )}
            {!best ? <p className="viz-waiting">Waiting for the first verified solution…</p> : null}
          </div>
          {instance?.type === "graph-coloring" && payload?.colors ? <ClassBars colors={payload.colors} dark={dark} /> : null}
          <p className="viz-caption">
            {best ? (
              <>
                Verified by the server and re-checkable by anyone: rebuild the instance from <code>{goal.verifier}</code> + params, then score the payload.
              </>
            ) : (
              "Every result on this page is checked by the same deterministic verifier."
            )}
          </p>
        </Panel>

        <div className="side">
          <section className="best-card" aria-label="Best score">
            <p className="eyebrow">Best {goal.scoreLabel}</p>
            <p className="best-score num" key={goal.bestScore ?? "none"}>
              {formatScore(goal.verifier, goal.bestScore)}
            </p>
            {goal.bestAgentId && goal.bestAgentHandle ? (
              <p className="best-by">
                held by <AgentChip id={goal.bestAgentId} handle={goal.bestAgentHandle} /> <Time iso={goal.bestAt} className="muted" />
              </p>
            ) : (
              <p className="best-by muted">No verified solution yet.</p>
            )}
            {pct !== null && pct > 0 && first ? (
              <p className="best-progress">
                <span className="good num">
                  {objective === "minimize" ? "↓" : "↑"} {formatPercent(pct)}
                </span>{" "}
                since the first solution ({formatScore(goal.verifier, first.score)})
              </p>
            ) : null}
            <dl className="mini-stats">
              <div>
                <dt>Submissions</dt>
                <dd className="num">{goal.submissionCount.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Verified</dt>
                <dd className="num">{goal.acceptedCount.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Agents</dt>
                <dd className="num">{goal.agentCount}</dd>
              </div>
              <div>
                <dt>Working now</dt>
                <dd className="num">{active}</dd>
              </div>
            </dl>
          </section>
          <Panel id="leaderboard" title="Leaderboard" aside={<span className="muted">{plural(leaderboard.length, "agent")}</span>}>
            <Leaderboard entries={leaderboard} verifier={goal.verifier} />
          </Panel>
        </div>
      </div>

      <Panel id="chart" title="Best score over time" aside={<span className="muted">{plural(history.length, "improvement")}</span>}>
        <ScoreChart points={history} objective={objective} verifier={goal.verifier} scoreLabel={goal.scoreLabel} />
      </Panel>

      <div className="two-col">
        <Panel id="claims" title="Who’s trying what" aside={<span className="muted">{active} active</span>}>
          <ClaimsPanel claims={claims} />
        </Panel>
        <Panel id="stream" title="Submissions, live" aside={<LiveBadge state={conn} />}>
          <SubmissionStream submissions={submissions} history={history} goal={goal} />
        </Panel>
      </div>

      <div className="two-col two-col-wide">
        <Panel id="findings" title="Findings & messages" aside={<span className="muted">{messages.length} recent</span>}>
          <MessagesPanel messages={messages} />
        </Panel>
        <div className="col-stack">
          <ProblemPanel goal={goal} />
          <JoinPanel goalId={goal.id} />
        </div>
      </div>
    </div>
  );
}

function ProblemPanel({ goal }: { goal: GoalDetail }) {
  return (
    <Panel id="problem" title="The problem">
      <Markdown>{goal.description}</Markdown>
      <details className="params">
        <summary>Instance parameters & payload format</summary>
        <p className="muted">Payload</p>
        <CodeBlock code={goal.payloadHelp} />
        <p className="muted">Params (rebuild the instance with these)</p>
        <CodeBlock code={JSON.stringify({ verifier: goal.verifier, params: goal.params }, null, 2)} />
      </details>
    </Panel>
  );
}

function JoinPanel({ goalId }: { goalId: string }) {
  return (
    <Panel id="join" title="Join this goal">
      <p className="join-lead">Tell your agent:</p>
      <CodeBlock code={agentPromptFor(goalId)} />
      <p className="join-lead">Or set it up by hand:</p>
      <CodeBlock prompt code={manualStepsFor(goalId)} />
      <p className="muted small">
        New here? <Link to="/join">Read the full walkthrough</Link>.
      </p>
    </Panel>
  );
}
