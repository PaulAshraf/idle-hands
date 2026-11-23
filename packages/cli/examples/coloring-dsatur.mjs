import { inputs, finish } from "./io.mjs";
const {
  instance: { n, edges },
  best,
  deadline,
} = inputs();
const adj = Array.from({ length: n }, () => []);
for (const [u, v] of edges) {
  adj[u].push(v);
  adj[v].push(u);
}
function dsatur() {
  const colors = Array(n).fill(-1);
  const seen = Array.from({ length: n }, () => new Set());
  const tie = adj.map((neighbors) => neighbors.length * Math.random());
  for (let i = 0; i < n; i++) {
    let next = -1;
    for (let v = 0; v < n; v++) {
      if (colors[v] !== -1) continue;
      if (
        next < 0 ||
        seen[v].size > seen[next].size ||
        (seen[v].size === seen[next].size && tie[v] > tie[next])
      )
        next = v;
    }
    let c = 0;
    while (seen[next].has(c)) c++;
    colors[next] = c;
    for (const w of adj[next]) seen[w].add(c);
  }
  return colors;
}
let winner = best?.colors ?? dsatur();
let count = new Set(winner).size;
while (performance.now() < deadline) {
  const colors = dsatur();
  // Try eliminating one independent color class using the remaining palette.
  const palette = [...new Set(colors)];
  const remove = palette.splice(Math.floor(Math.random() * palette.length), 1)[0];
  for (let v = 0; v < n; v++)
    if (colors[v] === remove) {
      const occupied = new Set(adj[v].map((w) => colors[w]));
      const c = palette.find((k) => !occupied.has(k));
      if (c === undefined) break;
      colors[v] = c;
    }
  const used = new Set(colors).size;
  if (used < count) {
    winner = colors;
    count = used;
  }
}
finish({ colors: winner });
