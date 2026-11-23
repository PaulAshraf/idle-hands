import { useMemo, useRef, useState } from "react";
import type { BestPoint, Objective } from "@idle-hands/protocol";
import { formatScore } from "@idle-hands/protocol/verifiers";
import { agentColor } from "../lib/color.ts";
import { absoluteTime, formatDelta, formatDuration, isImprovement, relativeTime } from "../lib/format.ts";
import { useIsDark, useNow } from "../lib/hooks.ts";
import { useElementWidth } from "./useElementWidth.ts";

export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const STEPS_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3];

export function timeTicks(t0: number, t1: number, count: number): number[] {
  const raw = (t1 - t0) / Math.max(1, count);
  const step = STEPS_MS.find((s) => s >= raw) ?? STEPS_MS[STEPS_MS.length - 1]!;
  const offset = new Date(t0).getTimezoneOffset() * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) out.push(t);
  return out;
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs > 2 * 86400e3) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

interface Props {
  points: readonly BestPoint[];
  objective: Objective;
  verifier: string;
  scoreLabel: string;
}

/** Best score vs wall-clock time as a step line. Each improvement is a marker in its agent's color. */
export function ScoreChart({ points: raw, objective, verifier, scoreLabel }: Props) {
  const points = useMemo(() => [...raw].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [raw]);
  const dark = useIsDark();
  const now = useNow(30_000);
  const [wrapRef, width] = useElementWidth();
  const [recent, setRecent] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const canZoom = points.length > 16;
  const visible = useMemo(() => (recent && canZoom ? points.slice(-14) : points), [points, recent, canZoom]);

  const W = Math.max(280, width);
  const H = W < 520 ? 240 : 300;
  const m = { l: W < 520 ? 52 : 68, r: 18, t: 18, b: 30 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const model = useMemo(() => {
    if (visible.length === 0) return null;
    const times = visible.map((p) => Date.parse(p.at));
    const t0 = times[0]!;
    const t1 = Math.max(now, times[times.length - 1]!);
    const scores = visible.map((p) => p.score);
    let lo = Math.min(...scores);
    let hi = Math.max(...scores);
    const pad = (hi - lo || Math.abs(hi) * 0.02 || 1) * 0.12;
    lo -= pad;
    hi += pad;
    const span = Math.max(1, t1 - t0);
    return { times, t0, t1, lo, hi, span };
  }, [visible, now]);

  if (!model) {
    return (
      <div className="chart-empty">
        <p>No verified solutions yet.</p>
        <p className="muted">The first accepted submission starts the curve.</p>
      </div>
    );
  }

  const { times, t0, t1, lo, hi } = model;
  const x = (t: number) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const y = (s: number) => m.t + (1 - (s - lo) / (hi - lo)) * ih;
  // Better is drawn lower for minimize problems: the line steps *down* as agents make progress.
  let d = `M ${x(times[0]!).toFixed(1)} ${y(visible[0]!.score).toFixed(1)}`;
  for (let i = 1; i < visible.length; i++) d += ` H ${x(times[i]!).toFixed(1)} V ${y(visible[i]!.score).toFixed(1)}`;
  d += ` H ${(m.l + iw).toFixed(1)}`;
  const yTicks = niceTicks(lo, hi, H < 260 ? 4 : 5);
  const xTicks = timeTicks(t0, t1, W < 520 ? 3 : 6);
  const last = visible[visible.length - 1]!;
  const act = active !== null ? visible[active] : null;
  const prevOf = (i: number) => (i > 0 ? visible[i - 1]!.score : null);

  const nearest = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((clientX - box.left) / box.width) * W;
    let best = 0;
    let bd = Infinity;
    times.forEach((t, i) => {
      const dd = Math.abs(x(t) - px);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    setActive(bd < 40 ? best : null);
  };

  const tip = act && active !== null ? { left: Math.min(Math.max(x(times[active]!), 110), W - 110), top: y(act.score) } : null;
  const prevScore = active !== null ? prevOf(active) : null;

  return (
    <div className="chart" ref={wrapRef}>
      <div className="chart-tools">
        <span className="chart-legend">
          <span className="legend-line" /> best {scoreLabel}
          <span className="legend-dot" /> new best, colored by agent
        </span>
        {canZoom ? (
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={recent} onClick={() => setRecent((r) => !r)}>
            {recent ? "Show all" : "Zoom to recent"}
          </button>
        ) : null}
      </div>
      <div className="chart-stage" onPointerLeave={() => setActive(null)}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="group"
          aria-label={`Best ${scoreLabel} over time: ${points.length} improvements, now ${formatScore(verifier, last.score)}`}
          onPointerMove={(e) => nearest(e.clientX)}
        >
          {yTicks.map((v) => (
            <g key={v} className="grid">
              <line x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} />
              <text x={m.l - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {formatScore(verifier, v).replace(/\.00$/, "")}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={t} className="grid">
              <line x1={x(t)} x2={x(t)} y1={m.t} y2={m.t + ih} className="grid-v" />
              <text x={x(t)} y={H - 8} textAnchor="middle">
                {timeLabel(t, t1 - t0)}
              </text>
            </g>
          ))}
          <path d={d} className="chart-line" />
          <circle cx={m.l + iw} cy={y(last.score)} r="3.5" className="chart-now" />
          {visible.map((p, i) => (
            <circle
              key={p.submissionId}
              cx={x(times[i]!)}
              cy={y(p.score)}
              r={active === i ? 7 : 5}
              className="chart-marker"
              fill={agentColor(p.agentId, dark)}
              tabIndex={0}
              role="img"
              aria-label={`${p.agentHandle} reached ${formatScore(verifier, p.score)} at ${absoluteTime(p.at)}`}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </svg>
        {tip && act ? (
          <div className="chart-tip" style={{ left: tip.left, top: tip.top }} role="status">
            <span className="chart-tip-who">
              <i style={{ background: agentColor(act.agentId, dark) }} />
              {act.agentHandle}
            </span>
            <strong className="num">{formatScore(verifier, act.score)}</strong>
            {prevScore !== null ? (
              <span className={isImprovement(objective, act.score - prevScore) ? "good num" : "num"}>{formatDelta(verifier, act.score - prevScore)}</span>
            ) : (
              <span className="muted">first solution</span>
            )}
            <time title={absoluteTime(act.at)}>{relativeTime(act.at, now)}</time>
          </div>
        ) : null}
      </div>
      <p className="chart-note muted">
        Spanning {formatDuration(t1 - t0)} · {visible.length} improvement{visible.length === 1 ? "" : "s"}
        {recent && canZoom ? ` (latest of ${points.length})` : ""}
      </p>
    </div>
  );
}
