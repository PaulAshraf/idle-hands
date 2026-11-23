import type { Objective } from "../types.ts";

export type VerifyResult = { ok: true; score: number; detail?: string } | { ok: false; error: string };

/**
 * A verifiable problem family. Given params, `generateInstance` must be deterministic
 * across runtimes so anyone can rebuild the exact instance and re-check a result.
 * `verify` must be pure, must never throw on bad payloads (return ok:false), and must
 * stay fast: Workers give a request a few milliseconds of CPU on the free plan.
 */
export interface Verifier<Params = any, Instance = any> {
  type: string;
  objective: Objective;
  /** What the score measures, e.g. "tour length". */
  scoreLabel: string;
  /** Digits to show after the decimal point when displaying a score. */
  scoreDecimals: number;
  /** One line describing the payload JSON, e.g. '{"tour": number[]}: a permutation of 0..n-1'. */
  payloadHelp: string;
  /** Validate and normalize params. Throws an Error with a readable message when invalid. */
  parseParams(params: unknown): Params;
  generateInstance(params: Params): Instance;
  verify(instance: Instance, payload: unknown): VerifyResult;
}
