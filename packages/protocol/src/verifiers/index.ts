import type { Objective } from "../types.ts";
import { coloringVerifier } from "./coloring.ts";
import { tspVerifier } from "./tsp.ts";
import type { Verifier, VerifyResult } from "./types.ts";

export type { Verifier, VerifyResult } from "./types.ts";
export { tspVerifier, tourLength, type TspInstance, type TspParams, type TspPayload } from "./tsp.ts";
export { coloringVerifier, type ColoringInstance, type ColoringParams, type ColoringPayload } from "./coloring.ts";
export { createRng, hashSeed } from "./rng.ts";

const registry = new Map<string, Verifier>([
  [tspVerifier.type, tspVerifier],
  [coloringVerifier.type, coloringVerifier],
]);

export function listVerifiers(): Verifier[] {
  return [...registry.values()];
}

export function getVerifier(type: string): Verifier | undefined {
  return registry.get(type);
}

/** Relative tolerance for "strictly better", so float noise never counts as progress. */
const EPSILON = 1e-9;

/** True when score `a` is strictly better than `b` under `objective`. Anything beats null. */
export function isBetter(objective: Objective, a: number, b: number | null | undefined): boolean {
  if (b === null || b === undefined) return true;
  const margin = EPSILON * Math.max(1, Math.abs(b));
  return objective === "minimize" ? a < b - margin : a > b + margin;
}

/** Sort comparator: negative when `a` is the better score. */
export function compareScores(objective: Objective, a: number, b: number): number {
  return objective === "minimize" ? a - b : b - a;
}

export function formatScore(verifierType: string, score: number | null | undefined): string {
  if (score === null || score === undefined) return "—";
  const decimals = registry.get(verifierType)?.scoreDecimals ?? 2;
  return score.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const instanceCache = new Map<string, unknown>();
const INSTANCE_CACHE_LIMIT = 16;

/** Build (and memoize) the instance for a verifier type + params. Throws on unknown type or bad params. */
export function buildInstance(type: string, params: unknown): unknown {
  const verifier = registry.get(type);
  if (!verifier) throw new Error(`unknown verifier type "${type}"`);
  const key = `${type}:${JSON.stringify(params)}`;
  const cached = instanceCache.get(key);
  if (cached !== undefined) return cached;
  const instance = verifier.generateInstance(verifier.parseParams(params));
  if (instanceCache.size >= INSTANCE_CACHE_LIMIT) instanceCache.delete(instanceCache.keys().next().value!);
  instanceCache.set(key, instance);
  return instance;
}

/** Verify a payload against the instance defined by type + params. Never throws for bad payloads. */
export function verifyPayload(type: string, params: unknown, payload: unknown): VerifyResult {
  const verifier = registry.get(type);
  if (!verifier) return { ok: false, error: `unknown verifier type "${type}"` };
  let instance: unknown;
  try {
    instance = buildInstance(type, params);
  } catch (err) {
    return { ok: false, error: `goal is misconfigured: ${(err as Error).message}` };
  }
  try {
    return verifier.verify(instance, payload);
  } catch (err) {
    return { ok: false, error: `verifier crashed: ${(err as Error).message}` };
  }
}
