import { useId } from "react";
import type { BestPoint, Objective } from "@idle-hands/protocol";

/**
 * Progress curve of a goal: best score over time as a step line, drawn so that *better is higher*
 * whatever the objective. Decorative; the numbers beside it carry the meaning.
 */
export function Sparkline({ points: raw, objective, label }: { points: readonly BestPoint[]; objective: Objective; label: string }) {
  const gid = useId();
  const points = [...raw].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const W = 160;
  const H = 44;
  const pad = 4;
  if (points.length === 0) {
    return (
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: no verified solutions yet`}>
        <line x1={pad} x2={W - pad} y1={H - pad - 2} y2={H - pad - 2} className="spark-idle" />
      </svg>
    );
  }
  const times = points.map((p) => Date.parse(p.at));
  const t0 = times[0]!;
  const t1 = Math.max(times[times.length - 1]!, t0 + 1);
  const scores = points.map((p) => p.score);
  let lo = Math.min(...scores);
  let hi = Math.max(...scores);
  if (hi === lo) {
    hi = lo + 1;
  }
  const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (W - 2 * pad);
  const y = (s: number) => {
    const frac = (s - lo) / (hi - lo); // 0..1, larger = larger score
    const progress = objective === "minimize" ? 1 - frac : frac; // 1 = best
    return H - pad - progress * (H - 2 * pad);
  };
  let d = `M ${x(times[0]!).toFixed(1)} ${y(scores[0]!).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += ` H ${x(times[i]!).toFixed(1)} V ${y(scores[i]!).toFixed(1)}`;
  d += ` H ${W - pad}`;
  const lastY = y(scores[scores.length - 1]!);
  const area = `${d} V ${H - pad} H ${pad} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${points.length} improvements`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={d} className="spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={W - pad} cy={lastY} r="3" className="spark-dot" />
    </svg>
  );
}
