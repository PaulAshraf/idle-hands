import { formatScore } from "@idle-hands/protocol/verifiers";
import type { BestPoint, Objective, Submission } from "@idle-hands/protocol";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "42s ago", "2m ago", "3h ago", "5d ago", then a short date. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const diff = now - t;
  if (diff < 5 * SECOND) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** Full local date and time for hover titles. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

/** Clock-style remaining time: "12:04", "1h 05m", or "expired". */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const totalSeconds = Math.ceil(ms / SECOND);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Duration like "3m", "2h 10m", "4d". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / SECOND))}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(ms / DAY)}d`;
}

export function compactNumber(n: number): string {
  if (Math.abs(n) < 10_000) return n.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "AbCdEf…wXyZ": enough of the raw public key to recognise it, never the whole thing. */
export function shortKey(publicKey: string): string {
  if (publicKey.length <= 14) return publicKey;
  return `${publicKey.slice(0, 8)}…${publicKey.slice(-4)}`;
}

/** Key fingerprint: the hex tail of the id (sha256 of the key) in groups of four. */
export function fingerprint(agentId: string): string {
  const hex = agentId.replace(/^ih_/, "");
  return (hex.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

const KIND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  aider: "Aider",
  custom: "Custom",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Signed delta text where improvements read as "−", e.g. "−12.40" or "+3". Uses the verifier's decimals. */
export function formatDelta(verifierType: string, delta: number): string {
  if (delta === 0) return "±0";
  const sign = delta < 0 ? "−" : "+";
  return `${sign}${formatScore(verifierType, Math.abs(delta))}`;
}

/** True when moving the score by `delta` is progress under the objective. */
export function isImprovement(objective: Objective, delta: number): boolean {
  return objective === "minimize" ? delta < 0 : delta > 0;
}

/**
 * Score of the global best just before `sub` arrived: the last improvement strictly earlier than the
 * submission (and never the submission's own point). null when nothing had been verified yet.
 * `history` is oldest-first.
 */
export function bestBefore(sub: Pick<Submission, "id" | "createdAt">, history: readonly BestPoint[]): number | null {
  const t = Date.parse(sub.createdAt);
  let found: number | null = null;
  for (const p of history) {
    if (p.submissionId === sub.id) break;
    if (Date.parse(p.at) > t) break;
    found = p.score;
  }
  return found;
}

/** Delta of an accepted submission against the best at the time it arrived. null if rejected or no baseline. */
export function deltaVsBest(sub: Submission, history: readonly BestPoint[]): number | null {
  if (sub.status !== "accepted" || sub.score === null) return null;
  const base = bestBefore(sub, history);
  return base === null ? null : sub.score - base;
}

/** Percent improvement of the current best over the first recorded best (always ≥ 0 for sane data). */
export function improvementPercent(objective: Objective, history: readonly BestPoint[]): number | null {
  const first = history[0];
  const last = history[history.length - 1];
  if (!first || !last || first.score === 0) return null;
  const change = objective === "minimize" ? first.score - last.score : last.score - first.score;
  return (change / Math.abs(first.score)) * 100;
}

export function formatPercent(p: number): string {
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  return `${p.toFixed(2)}%`;
}
