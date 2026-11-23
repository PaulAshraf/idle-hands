import { createRng } from "./rng.ts";
import type { Verifier } from "./types.ts";

export interface TspParams {
  /** Number of cities, 3–5000. */
  n: number;
  seed: string | number;
  /** Coordinates are integers in [0, size). Default 10000. */
  size: number;
}

export interface TspInstance {
  type: "tsp";
  n: number;
  size: number;
  /** cities[i] = [x, y] */
  cities: [number, number][];
}

export interface TspPayload {
  tour: number[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Closed-tour Euclidean length, summed in tour order. Exported so solvers can reuse it. */
export function tourLength(cities: readonly (readonly [number, number])[], tour: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < tour.length; i++) {
    const a = cities[tour[i]!]!;
    const b = cities[tour[(i + 1) % tour.length]!]!;
    total += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return total;
}

export const tspVerifier: Verifier<TspParams, TspInstance> = {
  type: "tsp",
  objective: "minimize",
  scoreLabel: "tour length",
  scoreDecimals: 2,
  payloadHelp: '{"tour": number[]} — every city index 0..n-1 exactly once; the tour returns to its start.',

  parseParams(params) {
    if (!isRecord(params)) throw new Error("tsp params must be an object");
    const n = params.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 3 || n > 5000) throw new Error("tsp params.n must be an integer in 3..5000");
    const seed = params.seed;
    if (typeof seed !== "string" && typeof seed !== "number") throw new Error("tsp params.seed must be a string or number");
    const size = params.size ?? 10_000;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 10 || size > 1_000_000) throw new Error("tsp params.size must be an integer in 10..1000000");
    return { n, seed, size };
  },

  generateInstance({ n, seed, size }) {
    const rng = createRng(`tsp:${seed}`);
    const cities: [number, number][] = [];
    for (let i = 0; i < n; i++) cities.push([Math.floor(rng() * size), Math.floor(rng() * size)]);
    return { type: "tsp", n, size, cities };
  },

  verify(instance, payload) {
    if (!isRecord(payload) || !Array.isArray(payload.tour)) return { ok: false, error: 'payload must be {"tour": number[]}' };
    const tour = payload.tour as unknown[];
    if (tour.length !== instance.n) return { ok: false, error: `tour has ${tour.length} entries; expected ${instance.n}` };
    const seen = new Uint8Array(instance.n);
    for (let i = 0; i < tour.length; i++) {
      const c = tour[i];
      if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= instance.n) {
        return { ok: false, error: `tour[${i}] = ${JSON.stringify(c)} is not a city index in 0..${instance.n - 1}` };
      }
      if (seen[c]) return { ok: false, error: `city ${c} appears more than once (again at tour[${i}])` };
      seen[c] = 1;
    }
    const score = tourLength(instance.cities, tour as number[]);
    return { ok: true, score, detail: `closed tour through ${instance.n} cities` };
  },
};
