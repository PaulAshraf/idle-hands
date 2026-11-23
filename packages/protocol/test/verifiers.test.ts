import assert from "node:assert/strict";
import { test } from "node:test";
import { RegisterAgentBody, SubmitBody } from "../src/schemas.ts";
import {
  buildInstance,
  coloringVerifier,
  formatScore,
  isBetter,
  tspVerifier,
  verifyPayload,
  type ColoringInstance,
  type TspInstance,
} from "../src/verifiers/index.ts";

test("tsp instances are deterministic (pinned values guard cross-runtime drift)", () => {
  const a = buildInstance("tsp", { n: 200, seed: "idle-hands-1" }) as TspInstance;
  const b = tspVerifier.generateInstance(tspVerifier.parseParams({ n: 200, seed: "idle-hands-1" }));
  assert.deepEqual(a, b);
  assert.equal(a.cities.length, 200);
  // If this pin changes, every stored score for existing goals becomes unverifiable.
  assert.deepEqual(a.cities[0], PINNED_TSP_FIRST_CITY);
});

test("tsp verifier scores valid tours and explains invalid ones", () => {
  const params = { n: 5, seed: 7 };
  const ok = verifyPayload("tsp", params, { tour: [0, 1, 2, 3, 4] });
  assert.equal(ok.ok, true);
  assert.ok(ok.ok && ok.score > 0);
  const rotated = verifyPayload("tsp", params, { tour: [2, 3, 4, 0, 1] });
  assert.ok(ok.ok && rotated.ok && Math.abs(ok.score - rotated.score) < 1e-9);

  for (const [payload, fragment] of [
    [{ tour: [0, 1, 2, 3] }, "expected 5"],
    [{ tour: [0, 1, 2, 3, 3] }, "more than once"],
    [{ tour: [0, 1, 2, 3, 9] }, "not a city index"],
    [{ tour: [0, 1, 2, 3, 1.5] }, "not a city index"],
    [{ order: [] }, "payload must be"],
    [null, "payload must be"],
  ] as const) {
    const res = verifyPayload("tsp", params, payload);
    assert.equal(res.ok, false);
    assert.ok(!res.ok && res.error.includes(fragment), `expected "${fragment}" in ${JSON.stringify(res)}`);
  }
});

test("graph-coloring verifier counts colors and finds conflicts", () => {
  const params = { n: 30, p: 0.3, seed: "t" };
  const inst = buildInstance("graph-coloring", params) as ColoringInstance;
  assert.ok(inst.edges.length > 0);
  const distinct = { colors: Array.from({ length: 30 }, (_, i) => i) };
  const res = verifyPayload("graph-coloring", params, distinct);
  assert.ok(res.ok && res.score === 30);

  const [u, v] = inst.edges[0]!;
  const bad = distinct.colors.slice();
  bad[v] = bad[u]!;
  const conflict = verifyPayload("graph-coloring", params, { colors: bad });
  assert.ok(!conflict.ok && conflict.error.includes(`edge ${u}–${v}`));
  assert.equal(coloringVerifier.objective, "minimize");
});

test("unknown verifier types and bad params fail cleanly", () => {
  assert.equal(verifyPayload("nope", {}, {}).ok, false);
  const res = verifyPayload("tsp", { n: 1, seed: 1 }, { tour: [0] });
  assert.ok(!res.ok && res.error.startsWith("goal is misconfigured"));
});

test("isBetter respects objective and tolerance", () => {
  assert.equal(isBetter("minimize", 10, null), true);
  assert.equal(isBetter("minimize", 9, 10), true);
  assert.equal(isBetter("minimize", 10, 10), false);
  assert.equal(isBetter("minimize", 10 - 1e-12, 10), false);
  assert.equal(isBetter("maximize", 11, 10), true);
  assert.equal(isBetter("maximize", 9, 10), false);
});

test("formatScore uses each verifier's precision", () => {
  assert.equal(formatScore("tsp", 12345.678), "12,345.68");
  assert.equal(formatScore("graph-coloring", 17), "17");
  assert.equal(formatScore("tsp", null), "—");
});

test("request schemas normalize optional text", () => {
  const reg = RegisterAgentBody.parse({ publicKey: "a".repeat(43), handle: "night-owl", kind: "codex", operator: "  " });
  assert.equal(reg.operator, undefined);
  assert.throws(() => RegisterAgentBody.parse({ publicKey: "a".repeat(43), handle: "Bad Handle", kind: "x" }));
  assert.throws(() => SubmitBody.parse({}));
  assert.deepEqual(SubmitBody.parse({ payload: { tour: [] }, note: "" }).note, undefined);
});

const PINNED_TSP_FIRST_CITY: [number, number] = [8516, 617];
