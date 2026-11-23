/** Cheap real solvers that drive the mock swarm: the tours and colorings it submits are genuinely improving and verifier-valid. */

type Pt = readonly [number, number];
export type Rng = () => number;

const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function nearestNeighbour(cities: readonly Pt[], start = 0): number[] {
  const n = cities.length;
  const used = new Uint8Array(n);
  const tour = [start];
  used[start] = 1;
  let cur = start;
  for (let k = 1; k < n; k++) {
    let best = -1;
    let bd = Infinity;
    const c = cities[cur]!;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const dd = (cities[j]![0] - c[0]) ** 2 + (cities[j]![1] - c[1]) ** 2;
      if (dd < bd) {
        bd = dd;
        best = j;
      }
    }
    used[best] = 1;
    tour.push(best);
    cur = best;
  }
  return tour;
}

/** K nearest neighbours of every city, nearest first. */
export function nearestLists(cities: readonly Pt[], k: number): number[][] {
  const n = cities.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ds: [number, number][] = [];
    for (let j = 0; j < n; j++) if (j !== i) ds.push([(cities[i]![0] - cities[j]![0]) ** 2 + (cities[i]![1] - cities[j]![1]) ** 2, j]);
    ds.sort((a, b) => a[0] - b[0]);
    out.push(ds.slice(0, k).map((x) => x[1]));
  }
  return out;
}

export type TourStyle = "2opt" | "oropt" | "mixed";

export interface ImproveOptions {
  /** Stop after this many improving moves. */
  maxMoves: number;
  /** Stop after this many candidate evaluations. */
  maxTrials: number;
  style: TourStyle;
  neighbours: number[][];
  rng: Rng;
  /** When set, most trials start from these cities (used to repair around a kick). */
  focus?: readonly number[];
}

/** First-improvement local search (2-opt and/or Or-opt) with neighbour lists. Returns a new tour; the input is untouched. */
export function improveTour(cities: readonly Pt[], input: readonly number[], opts: ImproveOptions): { tour: number[]; moves: number } {
  const n = input.length;
  let tour = input.slice();
  const pos = new Int32Array(n);
  const reindex = () => {
    for (let i = 0; i < n; i++) pos[tour[i]!] = i;
  };
  reindex();
  let moves = 0;
  const next = (i: number) => (i + 1) % n;
  const prev = (i: number) => (i + n - 1) % n;

  for (let trial = 0; trial < opts.maxTrials && moves < opts.maxMoves; trial++) {
    const i = opts.focus && opts.rng() < 0.85 ? pos[opts.focus[Math.floor(opts.rng() * opts.focus.length)]!]! : Math.floor(opts.rng() * n);
    const c = tour[i]!;
    const cand = opts.neighbours[c]!;
    const e = cand[Math.floor(opts.rng() * cand.length)]!;
    const useOr = opts.style === "oropt" || (opts.style === "mixed" && opts.rng() < 0.45);

    if (!useOr) {
      // 2-opt: replace edges (c, next c) and (e, next e) by (c, e) and (next c, next e).
      let a = i;
      let b = pos[e]!;
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
      if (b === next(a) || (a === 0 && b === n - 1)) continue;
      const A = tour[a]!;
      const A1 = tour[next(a)]!;
      const B = tour[b]!;
      const B1 = tour[next(b)]!;
      const delta = d(cities[A]!, cities[B]!) + d(cities[A1]!, cities[B1]!) - d(cities[A]!, cities[A1]!) - d(cities[B]!, cities[B1]!);
      if (delta < -1e-7) {
        for (let lo = a + 1, hi = b; lo < hi; lo++, hi--) {
          const t = tour[lo]!;
          tour[lo] = tour[hi]!;
          tour[hi] = t;
        }
        for (let k = a + 1; k <= b; k++) pos[tour[k]!] = k;
        moves++;
      }
    } else {
      // Or-opt: move a segment of 1–3 cities starting at c next to its neighbour e (either orientation).
      const L = 1 + Math.floor(opts.rng() * 3);
      if (n < L + 4) continue;
      const segIdx: number[] = [];
      for (let k = 0; k < L; k++) segIdx.push((i + k) % n);
      const ePos = pos[e]!;
      if (segIdx.includes(ePos)) continue;
      const p = tour[prev(i)]!;
      const a = tour[i]!;
      const b = tour[segIdx[L - 1]!]!;
      const q = tour[next(segIdx[L - 1]!)]!;
      if (p === q) continue;
      const removeGain = d(cities[p]!, cities[a]!) + d(cities[b]!, cities[q]!) - d(cities[p]!, cities[q]!);
      // Try inserting between e and its successor, then between its predecessor and e.
      let applied = false;
      for (const side of [0, 1]) {
        const lo = side === 0 ? ePos : prev(ePos);
        const hi = next(lo);
        if (segIdx.includes(lo) || segIdx.includes(hi)) continue;
        const x = tour[lo]!;
        const y = tour[hi]!;
        const forward = d(cities[x]!, cities[a]!) + d(cities[b]!, cities[y]!);
        const reversed = d(cities[x]!, cities[b]!) + d(cities[a]!, cities[y]!);
        const insert = Math.min(forward, reversed) - d(cities[x]!, cities[y]!);
        if (insert - removeGain < -1e-7) {
          const seg = segIdx.map((k) => tour[k]!);
          if (reversed < forward) seg.reverse();
          const rest = tour.filter((_, k) => !segIdx.includes(k));
          const at = rest.indexOf(x);
          rest.splice(at + 1, 0, ...seg);
          tour = rest;
          reindex();
          moves++;
          applied = true;
          break;
        }
      }
      if (applied) continue;
    }
  }
  return { tour, moves };
}

/** A local double bridge: three cuts within `window` positions. Returns the new tour and the cities it touched. */
export function kickLocal(tour: readonly number[], rng: Rng, window = 30): { tour: number[]; touched: number[] } {
  const n = tour.length;
  const w = Math.min(window, n - 2);
  const start = Math.floor(rng() * n);
  const cuts = [1 + Math.floor(rng() * (w - 1)), 1 + Math.floor(rng() * (w - 1)), 1 + Math.floor(rng() * (w - 1))].sort((a, b) => a - b) as [number, number, number];
  // Rotate so the window starts at index 0, apply the double bridge inside it, keep the rest.
  const rot = [...tour.slice(start), ...tour.slice(0, start)];
  const [i, j, k] = cuts;
  if (i === j || j === k) return { tour: rot, touched: [] };
  const out = [...rot.slice(0, i), ...rot.slice(j, k), ...rot.slice(i, j), ...rot.slice(k)];
  return { tour: out, touched: rot.slice(Math.max(0, i - 2), k + 2) };
}

/** Random segment reversal pair ("double bridge" lite): a kick for iterated local search. */
export function kick(tour: readonly number[], rng: Rng): number[] {
  const n = tour.length;
  const cuts = [1 + Math.floor(rng() * (n - 3)), 1 + Math.floor(rng() * (n - 3)), 1 + Math.floor(rng() * (n - 3))].sort((a, b) => a - b);
  const [i, j, k] = cuts as [number, number, number];
  if (i === j || j === k) return tour.slice();
  return [...tour.slice(0, i), ...tour.slice(j, k), ...tour.slice(i, j), ...tour.slice(k)];
}

// ---------------------------------------------------------------- graph coloring

export function greedyColoring(n: number, adj: readonly (readonly number[])[], order: readonly number[]): number[] {
  const color = new Array<number>(n).fill(-1);
  const stamp = new Int32Array(n + 1).fill(-1);
  for (const v of order) {
    for (const u of adj[v]!) if (color[u]! >= 0) stamp[color[u]!] = v;
    let c = 0;
    while (stamp[c] === v) c++;
    color[v] = c;
  }
  return color;
}

export function adjacency(n: number, edges: readonly (readonly [number, number])[]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    adj[u]!.push(v);
    adj[v]!.push(u);
  }
  return adj;
}

export function shuffled(n: number, rng: Rng): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function colorCount(colors: readonly number[]): number {
  return new Set(colors).size;
}

/** Culberson's iterated greedy: recolor class-by-class in a new class order. Never uses more colors than before. */
export function iteratedGreedy(n: number, adj: readonly (readonly number[])[], colors: readonly number[], rounds: number, rng: Rng): number[] {
  let cur = colors.slice();
  for (let r = 0; r < rounds; r++) {
    const classes = new Map<number, number[]>();
    cur.forEach((c, v) => {
      const list = classes.get(c);
      if (list) list.push(v);
      else classes.set(c, [v]);
    });
    const groups = [...classes.values()];
    const mode = rng();
    if (mode < 0.35) groups.sort((a, b) => b.length - a.length);
    else if (mode < 0.6) groups.reverse();
    else for (let i = groups.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [groups[i], groups[j]] = [groups[j]!, groups[i]!];
    }
    const next = greedyColoring(n, adj, groups.flat());
    if (colorCount(next) <= colorCount(cur)) cur = next;
  }
  return cur;
}

/** Compact the color ids to 0..k-1 so payloads stay tidy. */
export function normalizeColors(colors: readonly number[]): number[] {
  const map = new Map<number, number>();
  return colors.map((c) => {
    let m = map.get(c);
    if (m === undefined) {
      m = map.size;
      map.set(c, m);
    }
    return m;
  });
}
