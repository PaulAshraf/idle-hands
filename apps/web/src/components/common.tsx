import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { agentStyle } from "../lib/color.ts";
import { absoluteTime, formatCountdown, kindLabel, relativeTime } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import type { ConnectionState } from "../lib/live/client.ts";

/** Relative time ("2m ago") that keeps itself fresh; the absolute time is on hover. */
export function Time({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow(10_000);
  return (
    <time className={className} dateTime={iso ?? undefined} title={absoluteTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}

/** Agent identity: deterministic color dot + handle, linking to the profile. */
export function AgentChip({ id, handle, kind, plain }: { id: string; handle: string; kind?: string; plain?: boolean }) {
  const inner = (
    <>
      <span className="agent-dot" aria-hidden="true" />
      <span className="agent-handle">{handle}</span>
      {kind ? <span className="kind">{kindLabel(kind)}</span> : null}
    </>
  );
  return plain ? (
    <span className="agent" style={agentStyle(id)}>
      {inner}
    </span>
  ) : (
    <Link className="agent" style={agentStyle(id)} to={`/agents/${encodeURIComponent(id)}`}>
      {inner}
    </Link>
  );
}

const STATE_LABEL: Record<ConnectionState, string> = {
  live: "Live",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  polling: "Polling",
};
const STATE_HINT: Record<ConnectionState, string> = {
  live: "Connected: updates arrive the moment they happen.",
  connecting: "Opening the live connection…",
  reconnecting: "Connection lost. Retrying, and catching up on anything missed.",
  polling: "The live socket is unavailable, so this page checks for updates every few seconds.",
};

export function LiveBadge({ state }: { state: ConnectionState }) {
  return (
    <span className={`live-badge is-${state}`} role="status" title={STATE_HINT[state]}>
      <span className="live-dot" aria-hidden="true" />
      {STATE_LABEL[state]}
    </span>
  );
}

/** Lease countdown with a thin bar showing how much of the lease is left. */
export function Countdown({ expiresAt, heartbeatAt }: { expiresAt: string; heartbeatAt: string }) {
  const now = useNow(1000);
  const left = Date.parse(expiresAt) - now;
  const lease = Math.max(1, Date.parse(expiresAt) - Date.parse(heartbeatAt));
  const frac = Math.max(0, Math.min(1, left / lease));
  const low = left < 3 * 60_000;
  return (
    <span className={`countdown${low ? " is-low" : ""}`} title={`Lease expires ${absoluteTime(expiresAt)}. A heartbeat renews it.`}>
      <span className="countdown-time num">{formatCountdown(left)}</span>
      <span className="countdown-bar" aria-hidden="true">
        <span style={{ width: `${frac * 100}%` }} />
      </span>
    </span>
  );
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }, []);
  return [copied, copy];
}

function fallbackCopy(text: string, done: () => void) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } finally {
    ta.remove();
  }
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" className={`btn btn-ghost btn-sm ${className}`} onClick={() => copy(text)} aria-live="polite">
      {copied ? "Copied ✓" : label}
    </button>
  );
}

/** A copyable command or snippet. `prompt` adds a "$" gutter for shell lines. */
export function CodeBlock({ code, prompt, label }: { code: string; prompt?: boolean; label?: string }) {
  return (
    <div className="code">
      {label ? <div className="code-label">{label}</div> : null}
      <pre tabIndex={0}>
        <code>
          {code.split("\n").map((line, i) => (
            <span className="code-line" key={i} data-prompt={prompt && line.trim() ? "$" : undefined}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      <CopyButton text={code} className="code-copy" />
    </div>
  );
}

export function Panel({
  title,
  aside,
  children,
  className = "",
  id,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`panel ${className}`} aria-labelledby={id ? `${id}-title` : undefined} id={id}>
      <header className="panel-head">
        <h2 className="eyebrow" id={id ? `${id}-title` : undefined}>
          {title}
        </h2>
        {aside ? <div className="panel-aside">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-body">{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <p className="error-title">Something went wrong</p>
      <p className="error-body">{error.message}</p>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <dt className="eyebrow">{label}</dt>
      <dd className="num">{value}</dd>
      {hint ? <p className="stat-hint">{hint}</p> : null}
    </div>
  );
}
