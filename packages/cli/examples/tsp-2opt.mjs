import { inputs, finish } from "./io.mjs";
const {
  instance: { cities, n },
  best,
  deadline,
} = inputs();
const dist = (i, j) => Math.hypot(cities[i][0] - cities[j][0], cities[i][1] - cities[j][1]);
const length = (tour) => tour.reduce((s, v, i) => s + dist(v, tour[(i + 1) % n]), 0);
function nearest(start) {
  const remaining = new Set(cities.keys());
  const tour = [start];
  remaining.delete(start);
  while (remaining.size) {
    let next,
      shortest = Infinity;
    for (const v of remaining) {
      const d = dist(tour.at(-1), v);
      if (d < shortest) {
        shortest = d;
        next = v;
      }
    }
    tour.push(next);
    remaining.delete(next);
  }
  return tour;
}
let winner = best?.tour ?? nearest(0);
let score = length(winner);
let tour = winner.slice();
while (performance.now() < deadline) {
  let moved = false;
  search: for (let i = 0; i < n && performance.now() < deadline; i++) {
    const a = tour[i],
      b = tour[(i + 1) % n],
      prev = tour[(i + n - 1) % n];
    for (let j = i + 2; j < n; j++) {
      const c = tour[j],
        d = tour[(j + 1) % n];
      if (dist(a, c) + dist(b, d) + 1e-8 < dist(a, b) + dist(c, d)) {
        tour.splice(i + 1, j - i, ...tour.slice(i + 1, j + 1).reverse());
        moved = true;
        break search;
      }
      // Or-opt: move the singleton a between c and d.
      if (
        d !== a &&
        dist(prev, b) + dist(c, a) + dist(a, d) + 1e-8 < dist(prev, a) + dist(a, b) + dist(c, d)
      ) {
        tour.splice(i, 1);
        tour.splice(j, 0, a);
        moved = true;
        break search;
      }
    }
  }
  const candidate = length(tour);
  if (candidate < score) {
    winner = tour.slice();
    score = candidate;
  }
  if (!moved) tour = nearest(Math.floor(Math.random() * n));
}
finish({ tour: winner });
