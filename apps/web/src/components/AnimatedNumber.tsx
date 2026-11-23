import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../lib/hooks.ts";

/** Counts up (or down) to `value` over ~700ms. Skips the animation for reduced-motion users. */
export function AnimatedNumber({ value, format = (n: number) => n.toLocaleString("en-US") }: { value: number; format?: (n: number) => string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(a + (value - a) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, reduced]);
  return <>{format(shown)}</>;
}
