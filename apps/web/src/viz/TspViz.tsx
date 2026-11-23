import { useEffect, useRef } from "react";
import type { TspInstance } from "@idle-hands/protocol/verifiers";
import { agentColor } from "../lib/color.ts";
import { useIsDark, useReducedMotion } from "../lib/hooks.ts";
import { animate, easeOutCubic, useCanvas } from "./useCanvas.ts";

interface Props {
  instance: TspInstance;
  tour: readonly number[] | null;
  /** Agent that holds the best; tints the tour. */
  agentId: string | null;
  /** Changes when a new best lands (the best submission id). */
  version: string | null;
}

const key = (n: number, a: number, b: number) => (a < b ? a * n + b : b * n + a);

function edgeSet(tour: readonly number[]): Set<number> {
  const n = tour.length;
  const s = new Set<number>();
  for (let i = 0; i < n; i++) s.add(key(n, tour[i]!, tour[(i + 1) % n]!));
  return s;
}

/**
 * The best tour on a canvas. When a new best arrives, edges that disappeared linger in red and fade, edges that
 * appeared flash in the accent color with a pulse at their endpoints, then everything settles into the agent's color.
 */
export function TspViz({ instance, tour, agentId, version }: Props) {
  const { ref, wrap, size } = useCanvas(1);
  const dark = useIsDark();
  const reduced = useReducedMotion();
  const shown = useRef<readonly number[] | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const lastVersion = useRef<string | null>(null);
  const draw = useRef<(t: number, prev: readonly number[] | null) => void>(() => {});

  const pad = 18;
  const color = agentId ? agentColor(agentId, dark) : dark ? "#d9d2c3" : "#3a362e";
  const ink = dark ? "rgba(241,236,226,0.9)" : "rgba(28,26,22,0.85)";
  const accent = dark ? "#ff8a4c" : "#d9480f";
  const bad = dark ? "#ff6b6b" : "#c0261e";

  draw.current = (t, prev) => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || size.width === 0) return;
    const { width: w, height: h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const S = instance.size;
    const sx = (x: number) => pad + (x / S) * (w - 2 * pad);
    const sy = (y: number) => pad + (y / S) * (h - 2 * pad);
    const n = instance.n;
    const cities = instance.cities;
    const cur = shown.current;
    if (cur) {
      const curEdges = edgeSet(cur);
      const prevEdges = prev ? edgeSet(prev) : null;
      const added = new Set<number>();
      const removed: [number, number][] = [];
      if (prevEdges) {
        for (const e of curEdges) if (!prevEdges.has(e)) added.add(e);
        for (let i = 0; i < prev!.length; i++) {
          const a = prev![i]!;
          const b = prev![(i + 1) % prev!.length]!;
          if (!curEdges.has(key(n, a, b))) removed.push([a, b]);
        }
      }
      const lineW = n > 500 ? 1 : 1.5;
      const stroke = (a: number, b: number) => {
        ctx.moveTo(sx(cities[a]![0]), sy(cities[a]![1]));
        ctx.lineTo(sx(cities[b]![0]), sy(cities[b]![1]));
      };
      // Unchanged edges, in the holder's color.
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      for (let i = 0; i < cur.length; i++) {
        const a = cur[i]!;
        const b = cur[(i + 1) % cur.length]!;
        if (!added.has(key(n, a, b)) || t >= 1) stroke(a, b);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (prev && t < 1) {
        // Edges that were replaced fade out…
        ctx.strokeStyle = bad;
        ctx.globalAlpha = (1 - t * t) * 0.85;
        ctx.lineWidth = lineW + 0.6;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        for (const [a, b] of removed) stroke(a, b);
        ctx.stroke();
        ctx.setLineDash([]);
        // …new ones glow in the accent color and cool to the holder's color.
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 1 - t * t * 0.75;
        ctx.lineWidth = lineW + 2.6 * (1 - t * t);
        ctx.beginPath();
        for (let i = 0; i < cur.length; i++) {
          const a = cur[i]!;
          const b = cur[(i + 1) % cur.length]!;
          if (added.has(key(n, a, b))) stroke(a, b);
        }
        ctx.stroke();
        // Pulse rings where the tour changed.
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = accent;
        const seen = new Set<number>();
        for (const e of added) {
          for (const c of [Math.floor(e / n), e % n]) {
            if (seen.has(c) || seen.size > 40) continue;
            seen.add(c);
            ctx.beginPath();
            ctx.arc(sx(cities[c]![0]), sy(cities[c]![1]), 4 + 16 * easeOutCubic(t), 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
    }
    // Cities on top.
    ctx.fillStyle = ink;
    const r = n > 500 ? 1.3 : n > 200 ? 1.8 : 2.4;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(sx(cities[i]![0]), sy(cities[i]![1]), r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // Redraw statically on resize / theme change.
  useEffect(() => {
    if (!shown.current && tour) shown.current = tour; // never overwrite what a running transition is heading to
    draw.current(1, null);
  }, [size, dark, color, instance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animate when a new best arrives.
  useEffect(() => {
    if (!tour) return;
    const first = lastVersion.current === null;
    lastVersion.current = version;
    const prev = shown.current;
    shown.current = tour;
    cancel.current?.();
    if (first || reduced || !prev || prev === tour) {
      draw.current(1, null);
      return;
    }
    cancel.current = animate(2200, (t) => draw.current(t, prev), () => draw.current(1, null));
    return () => cancel.current?.();
  }, [tour, version, reduced]);

  return (
    <div className="viz-wrap" ref={wrap}>
      <canvas
        ref={ref}
        className="viz-canvas"
        style={{ width: size.width || "100%", height: size.height || undefined }}
        role="img"
        aria-label={tour ? `Current best tour through ${instance.n} cities` : `${instance.n} cities, no tour yet`}
      />
    </div>
  );
}
