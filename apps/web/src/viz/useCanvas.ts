import { useEffect, useRef, useState } from "react";

export interface CanvasSize {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
}

/**
 * A canvas that tracks its container's width. The backing store is scaled by devicePixelRatio so lines stay sharp.
 * Returns refs for the wrapper and the canvas, and the current CSS size.
 */
export function useCanvas(aspect = 1): { ref: React.RefObject<HTMLCanvasElement | null>; wrap: React.RefObject<HTMLDivElement | null>; size: CanvasSize } {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0, dpr: 1 });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const width = Math.floor(el.clientWidth);
      if (width <= 0) return;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      setSize((s) => (s.width === width && s.dpr === dpr ? s : { width, height: Math.round(width / aspect), dpr }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => {
    const c = ref.current;
    if (!c || size.width === 0) return;
    c.width = Math.round(size.width * size.dpr);
    c.height = Math.round(size.height * size.dpr);
  }, [size]);

  return { ref, wrap, size };
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Cancelable rAF loop: `step(t)` gets 0..1 progress over `ms`, then `done()` fires. Returns a cancel function. */
export function animate(ms: number, step: (t: number) => void, done?: () => void): () => void {
  let raf = 0;
  const start = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    step(t);
    if (t < 1) raf = requestAnimationFrame(frame);
    else done?.();
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
