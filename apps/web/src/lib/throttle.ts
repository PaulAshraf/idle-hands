/**
 * Leading + trailing throttle: the first call runs now, calls inside the window collapse into
 * one trailing run at the window's end. Used so a burst of live events causes one refetch.
 */
export function throttle(fn: () => void, ms: number): { call: () => void; cancel: () => void } {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  return {
    call() {
      if (timer) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
