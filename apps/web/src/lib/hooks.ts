import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FeedEvent } from "@idle-hands/protocol";
import { api, liveUrl } from "./api.ts";
import { LiveClient, type ConnectionState } from "./live/client.ts";

// ------------------------------------------------------------------ clock

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}
const clocks = new Map<number, Clock>();

function clockFor(ms: number): Clock {
  let c = clocks.get(ms);
  if (!c) {
    c = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(ms, c);
  }
  return c;
}

/** Current time in ms, re-rendering every `intervalMs`. One shared timer per interval, however many components ask. */
export function useNow(intervalMs = 1000): number {
  const clock = clockFor(intervalMs);
  const subscribe = useCallback(
    (cb: () => void) => {
      clock.listeners.add(cb);
      if (!clock.timer) {
        clock.now = Date.now();
        clock.timer = setInterval(() => {
          clock.now = Date.now();
          clock.listeners.forEach((l) => l());
        }, intervalMs);
      }
      return () => {
        clock.listeners.delete(cb);
        if (clock.listeners.size === 0 && clock.timer) {
          clearInterval(clock.timer);
          clock.timer = null;
        }
      };
    },
    [clock, intervalMs],
  );
  return useSyncExternalStore(subscribe, () => clock.now, () => clock.now);
}

// ------------------------------------------------------------------ theme

export type ThemePref = "system" | "light" | "dark";

function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem("ih-theme");
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage blocked */
  }
  return "system";
}

export function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    if (pref === "system") localStorage.removeItem("ih-theme");
    else localStorage.setItem("ih-theme", pref);
  } catch {
    /* storage blocked */
  }
}

export function initTheme(): void {
  applyThemePref(readThemePref());
}

const dark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function subscribeTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  dark?.addEventListener("change", cb);
  return () => {
    mo.disconnect();
    dark?.removeEventListener("change", cb);
  };
}

/** Whether the effective theme is dark (explicit toggle wins over the OS setting). For canvas drawing. */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    subscribeTheme,
    () => {
      const t = document.documentElement.getAttribute("data-theme");
      return t ? t === "dark" : (dark?.matches ?? false);
    },
    () => false,
  );
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const set = useCallback((p: ThemePref) => {
    applyThemePref(p);
    setPref(p);
  }, []);
  return [pref, set];
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

// ------------------------------------------------------------------ data

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch once per `key` (and again on `reload`). Stale responses from an earlier key are ignored. */
export function useResource<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: Error | null }>({ key, data: null, error: null });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const ctl = new AbortController();
    fetcherRef
      .current(ctl.signal)
      .then((data) => setState({ key, data, error: null }))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setState((s) => ({ key, data: s.key === key ? s.data : null, error }));
      });
    return () => ctl.abort();
  }, [key, tick]);

  const current = state.key === key ? state : { data: null, error: null };
  return {
    data: current.data,
    error: current.error,
    loading: current.data === null && current.error === null,
    reload: useCallback(() => setTick((t) => t + 1), []),
  };
}

/** One live socket for the component's lifetime (per goal, or global when `goalId` is undefined). */
export function useConnection(goalId: string | undefined, onEvent: (e: FeedEvent, meta: { replay: boolean }) => void): ConnectionState {
  const [state, setState] = useState<ConnectionState>("connecting");
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    setState("connecting");
    const client = new LiveClient({
      url: liveUrl(goalId),
      goalId,
      onEvent: (e, m) => cb.current(e, m),
      onState: setState,
      fetchFeed: (p) => api.feed(p),
    });
    client.start();
    return () => client.stop();
  }, [goalId]);
  return state;
}

export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · Idle Hands` : "Idle Hands: put idle agents to work on open problems";
  }, [title]);
}
