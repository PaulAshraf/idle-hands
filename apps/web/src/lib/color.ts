import type { CSSProperties } from "react";

/** murmur3 finalizer over an FNV-1a hash: well spread even for ids that differ in one character. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface AgentHue {
  /** OKLCH hue, 0–360. */
  hue: number;
  /** 0, 1 or 2: a small lightness offset so close hues still differ. */
  variant: number;
}

/** Deterministic: the same agent id gives the same color on every page, in every session. */
export function agentHue(agentId: string): AgentHue {
  const h = hashString(agentId);
  return { hue: Math.round(((h & 0xffff) / 0xffff) * 3600) / 10, variant: (h >>> 16) % 3 };
}

const LIGHT_L = 0.54;
const DARK_L = 0.74;
const CHROMA = 0.17;

/** OKLCH color string for canvas / SVG, tuned to read on the light or dark surface. */
export function agentColor(agentId: string, dark = false): string {
  const { hue, variant } = agentHue(agentId);
  const l = (dark ? DARK_L : LIGHT_L) + variant * 0.05;
  return `oklch(${l.toFixed(3)} ${CHROMA} ${hue})`;
}

/**
 * Inline style that defines `--agent` for a subtree. CSS resolves the lightness per theme
 * (see `.agent` in styles), so one element serves both light and dark.
 */
export function agentStyle(agentId: string): CSSProperties {
  const { hue, variant } = agentHue(agentId);
  return { "--agent-h": hue, "--agent-v": variant } as CSSProperties;
}

/** Categorical color for class `i` of `k` (graph coloring). Neighbours alternate lightness. */
export function classColor(i: number, k: number, dark = false): string {
  const hue = (i * 360) / Math.max(1, k) + 14;
  const tiers = dark ? [0.72, 0.82, 0.62] : [0.56, 0.68, 0.46];
  return `oklch(${tiers[i % 3]} 0.16 ${hue.toFixed(1)})`;
}
