import { createRng } from "./rng.ts";
import type { Verifier } from "./types.ts";

export interface ColoringParams {
  /** Number of vertices, 2–2000. */
  n: number;
  /** Probability of each possible edge, (0, 1). */
  p: number;
  seed: string | number;
}

export interface ColoringInstance {
  type: "graph-coloring";
  n: number;
  /** Undirected edges [u, v] with u < v. */
  edges: [number, number][];
}

export interface ColoringPayload {
  colors: number[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const coloringVerifier: Verifier<ColoringParams, ColoringInstance> = {
  type: "graph-coloring",
  objective: "minimize",
  scoreLabel: "colors used",
  scoreDecimals: 0,
  payloadHelp: '{"colors": number[]} — colors[v] is a non-negative integer for each vertex v; no edge may join two vertices of the same color.',

  parseParams(params) {
    if (!isRecord(params)) throw new Error("graph-coloring params must be an object");
    const { n, p, seed } = params;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 2 || n > 2000) throw new Error("graph-coloring params.n must be an integer in 2..2000");
    if (typeof p !== "number" || !(p > 0 && p < 1)) throw new Error("graph-coloring params.p must be a number in (0, 1)");
    if (typeof seed !== "string" && typeof seed !== "number") throw new Error("graph-coloring params.seed must be a string or number");
    return { n, p, seed };
  },

  generateInstance({ n, p, seed }) {
    const rng = createRng(`graph-coloring:${seed}`);
    const edges: [number, number][] = [];
    for (let u = 0; u < n; u++) {
      for (let v = u + 1; v < n; v++) {
        if (rng() < p) edges.push([u, v]);
      }
    }
    return { type: "graph-coloring", n, edges };
  },

  verify(instance, payload) {
    if (!isRecord(payload) || !Array.isArray(payload.colors)) return { ok: false, error: 'payload must be {"colors": number[]}' };
    const colors = payload.colors as unknown[];
    if (colors.length !== instance.n) return { ok: false, error: `colors has ${colors.length} entries; expected ${instance.n}` };
    const used = new Set<number>();
    for (let v = 0; v < colors.length; v++) {
      const c = colors[v];
      if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= instance.n) {
        return { ok: false, error: `colors[${v}] = ${JSON.stringify(c)} is not an integer in 0..${instance.n - 1}` };
      }
      used.add(c);
    }
    for (const [u, v] of instance.edges) {
      if (colors[u] === colors[v]) return { ok: false, error: `edge ${u}–${v} joins two vertices colored ${colors[u]}` };
    }
    return { ok: true, score: used.size, detail: `proper coloring of ${instance.n} vertices and ${instance.edges.length} edges` };
  },
};
