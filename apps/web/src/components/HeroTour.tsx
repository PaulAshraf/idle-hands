import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createRng } from "@idle-hands/protocol/verifiers";
import { useReducedMotion } from "../lib/hooks.ts";

const W = 420;
const H = 300;
const N = 26;

type P = [number, number];

function dist(a: P, b: P) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** One random improving 2-opt move, or a kick when the tour is already 2-optimal. */
function step(pts: P[], tour: number[], rng: () => number): number[] {
  const n = tour.length;
  const moves: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = pts[tour[i]!]!;
      const b = pts[tour[i + 1]!]!;
      const c = pts[tour[j]!]!;
      const d = pts[tour[(j + 1) % n]!]!;
      if (dist(a, c) + dist(b, d) < dist(a, b) + dist(c, d) - 1e-6) moves.push([i, j]);
    }
  }
  const next = tour.slice();
  if (moves.length) {
    const [i, j] = moves[Math.floor(rng() * moves.length)]!;
    const seg = next.slice(i + 1, j + 1).reverse();
    next.splice(i + 1, j - i, ...seg);
    return next;
  }
  // Kick: swap two far-apart cities, so the "agent" has something to fix again.
  const a = Math.floor(rng() * n);
  const b = (a + 5 + Math.floor(rng() * (n - 10))) % n;
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

/** A tiny TSP that keeps getting solved and shaken up: idle hands, at work. Decorative only. */
export function HeroTour() {
  const reduced = useReducedMotion();
  const { pts, start } = useMemo(() => {
    const rng = createRng("idle-hands-hero");
    const pts: P[] = Array.from({ length: N }, () => [24 + rng() * (W - 48), 24 + rng() * (H - 48)]);
    const tour = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [tour[i], tour[j]] = [tour[j]!, tour[i]!];
    }
    return { pts, start: tour };
  }, []);
  const [tour, setTour] = useState(start);

  useEffect(() => {
    const rng = createRng("hero-moves");
    if (reduced) {
      let t = start;
      for (let k = 0; k < 120; k++) t = step(pts, t, rng);
      setTour(t);
      return;
    }
    const id = setInterval(() => setTour((t) => step(pts, t, rng)), 520);
    return () => clearInterval(id);
  }, [pts, start, reduced]);

  const d = tour.map((c, i) => `${i ? "L" : "M"}${pts[c]![0].toFixed(1)} ${pts[c]![1].toFixed(1)}`).join(" ") + " Z";
  return (
    <svg className="hero-tour" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <path d={d} style={{ d: `path("${d}")` } as CSSProperties} className="hero-tour-path" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === tour[0] ? 5 : 3} className={i === tour[0] ? "hero-tour-start" : "hero-tour-dot"} />
      ))}
    </svg>
  );
}
