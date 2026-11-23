import { useEffect, useMemo, useRef } from "react";
import type { ColoringInstance } from "@idle-hands/protocol/verifiers";
import { classColor } from "../lib/color.ts";
import { useIsDark, useReducedMotion } from "../lib/hooks.ts";
import { animate, easeInOut, easeOutCubic, useCanvas } from "./useCanvas.ts";

interface Props {
  instance: ColoringInstance;
  colors: readonly number[] | null;
  version: string | null;
}

interface Layout {
  /** Angle (radians) of every vertex. */
  angle: Float32Array;
  /** Class index (0 = largest class) of every vertex. */
  cls: Int32Array;
  /** Vertices per class, largest first. */
  sizes: number[];
}

/** Group vertices by color class, largest class first, and spread them around a circle class by class. */
export function layoutColoring(n: number, colors: readonly number[]): Layout {
  const groups = new Map<number, number[]>();
  colors.forEach((c, v) => {
    const g = groups.get(c);
    if (g) g.push(v);
    else groups.set(c, [v]);
  });
  const ordered = [...groups.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  const angle = new Float32Array(n);
  const cls = new Int32Array(n);
  let i = 0;
  ordered.forEach((members, k) => {
    for (const v of members) {
      angle[v] = -Math.PI / 2 + (i / n) * Math.PI * 2;
      cls[v] = k;
      i++;
    }
  });
  return { angle, cls, sizes: ordered.map((m) => m.length) };
}

/**
 * Vertices on a circle, grouped by color class so each class is one arc. Every edge is drawn as a faint chord,
 * which makes the density of the graph visible; a proper coloring never has a chord inside an arc.
 * A new best slides the vertices into their new arcs.
 */
export function ColoringViz({ instance, colors, version }: Props) {
  const { ref, wrap, size } = useCanvas(1);
  const dark = useIsDark();
  const reduced = useReducedMotion();
  const layout = useMemo(() => (colors ? layoutColoring(instance.n, colors) : null), [instance.n, colors]);
  const shown = useRef<Layout | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const lastVersion = useRef<string | null>(null);
  const draw = useRef<(t: number, from: Layout | null) => void>(() => {});

  draw.current = (t, from) => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || size.width === 0) return;
    const { width: w, height: h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 16;
    const n = instance.n;
    const to = shown.current;
    const k = to ? to.sizes.length : 1;

    // Current angle of each vertex (interpolated along the shorter arc during a transition).
    const ang = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      if (!to) ang[v] = -Math.PI / 2 + (v / n) * Math.PI * 2;
      else if (from && t < 1) {
        let d = to.angle[v]! - from.angle[v]!;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        ang[v] = from.angle[v]! + d * easeInOut(t);
      } else ang[v] = to.angle[v]!;
    }
    const px = (v: number) => cx + Math.cos(ang[v]!) * R;
    const py = (v: number) => cy + Math.sin(ang[v]!) * R;

    // Edges first: thousands of hairlines.
    const stride = Math.max(1, Math.ceil(instance.edges.length / 2500)); // a sample is plenty to show the density
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = dark ? "rgba(241,236,226,0.07)" : "rgba(28,26,22,0.075)";
    ctx.beginPath();
    for (let i = 0; i < instance.edges.length; i += stride) {
      const [u, v] = instance.edges[i]!;
      ctx.moveTo(px(u), py(u));
      ctx.lineTo(px(v), py(v));
    }
    ctx.stroke();

    // Pulse ring on the circle while a new best settles.
    if (from && t < 1) {
      ctx.strokeStyle = dark ? "#ff8a4c" : "#d9480f";
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.lineWidth = 2 + 6 * (1 - t);
      ctx.beginPath();
      ctx.arc(cx, cy, R + 4 + 10 * easeOutCubic(t), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const r = n > 400 ? 3.2 : n > 150 ? 4.2 : 5.5;
    for (let v = 0; v < n; v++) {
      ctx.fillStyle = to ? classColor(to.cls[v]!, k, dark) : dark ? "#6f695c" : "#aaa292";
      ctx.beginPath();
      ctx.arc(px(v), py(v), r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  useEffect(() => {
    if (!shown.current && layout) shown.current = layout;
    draw.current(1, null);
  }, [size, dark, instance]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!layout) return;
    const first = lastVersion.current === null;
    lastVersion.current = version;
    const prev = shown.current;
    shown.current = layout;
    cancel.current?.();
    if (first || reduced || !prev || prev === layout) {
      draw.current(1, null);
      return;
    }
    cancel.current = animate(1300, (t) => draw.current(t, prev), () => draw.current(1, null));
    return () => cancel.current?.();
  }, [layout, version, reduced]);

  return (
    <div className="viz-wrap" ref={wrap}>
      <canvas
        ref={ref}
        className="viz-canvas"
        style={{ width: size.width || "100%", height: size.height || undefined }}
        role="img"
        aria-label={layout ? `Best coloring: ${layout.sizes.length} colors on ${instance.n} vertices` : `${instance.n} vertices, no coloring yet`}
      />
    </div>
  );
}

/** Horizontal bars: how many vertices each color class holds, largest first. */
export function ClassBars({ colors, dark }: { colors: readonly number[]; dark: boolean }) {
  const { sizes } = useMemo(() => layoutColoring(colors.length, colors), [colors]);
  const max = sizes[0] ?? 1;
  return (
    <figure className="class-bars">
      <figcaption className="eyebrow">Color class sizes</figcaption>
      <ol>
        {sizes.map((s, i) => (
          <li key={i} title={`Class ${i + 1}: ${s} vertices`}>
            <span style={{ width: `${(s / max) * 100}%`, background: classColor(i, sizes.length, dark) }} />
          </li>
        ))}
      </ol>
      <p className="class-bars-note">
        {sizes.length} classes · largest {sizes[0] ?? 0} · smallest {sizes[sizes.length - 1] ?? 0}
      </p>
    </figure>
  );
}
