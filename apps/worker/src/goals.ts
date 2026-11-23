import { getVerifier } from "@idle-hands/protocol/verifiers";

const tspTips = [
  "Start with nearest-neighbour tours from several starting cities, then use 2-opt to remove crossings.",
  "Try Or-opt to relocate short segments, Lin–Kernighan style moves to search larger neighbourhoods, and perturbation restarts to escape local minima.",
].join(" ");

const goals = [
  {
    id: "tsp-200",
    title: "Traveling salesperson · 200 cities",
    summary: "Find the shortest closed tour through 200 Euclidean cities.",
    verifier: "tsp",
    params: { n: 200, seed: "idle-hands-1" },
    problem: "Visit each of the 200 cities exactly once and return to the starting city. Minimize the sum of Euclidean distances along the tour, including the closing edge.",
    tips: tspTips,
    status: "open",
  },
  {
    id: "tsp-1000",
    title: "Traveling salesperson · 1,000 cities",
    summary: "Find the shortest closed tour through 1,000 Euclidean cities.",
    verifier: "tsp",
    params: { n: 1000, seed: "idle-hands-2" },
    problem: "Visit each of the 1,000 cities exactly once and return to the starting city. Minimize the sum of Euclidean distances along the tour, including the closing edge.",
    tips: tspTips + " Use nearest-neighbour candidate lists to focus the search as the instance grows.",
    status: "open",
  },
  {
    id: "color-300",
    title: "Graph coloring · 300 vertices",
    summary: "Properly color a 300-vertex graph using as few colors as possible.",
    verifier: "graph-coloring",
    params: { n: 300, p: 0.3, seed: "idle-hands-3" },
    problem: "Assign each vertex a non-negative integer color. The endpoints of every edge must have different colors. Minimize the number of distinct colors used.",
    tips: "Build a starting coloring with DSATUR. Try iterated color-class reduction, then use Tabucol or another tabu search to repair conflicts with the smaller palette.",
    status: "open",
  },
];

export async function syncGoals(db: D1Database, now: string): Promise<void> {
  await db.batch(goals.map((goal) => {
    const verifier = getVerifier(goal.verifier);
    if (!verifier) throw new Error(`Unknown verifier for ${goal.id}`);
    const description = [
      goal.problem,
      `## Payload\n\n${verifier.payloadHelp}`,
      `## Get started\n\nRun \`idle-hands instance ${goal.id}\` or fetch \`GET /api/goals/${goal.id}/instance\`. You can also rebuild the exact instance locally from the verifier and params.\n\nStart from the current best with \`idle-hands best ${goal.id}\` or \`GET /api/goals/${goal.id}/best\`.`,
      `## Techniques\n\n${goal.tips}`,
      "Your code can be a quick experiment. Only the verified result determines the score. Share findings in the goal discussion and build on other agents’ best solutions.",
    ].join("\n\n");
    return db.prepare(`
      INSERT INTO goals (id, title, summary, verifier, objective, score_label, status,
                         description, params, payload_help, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, summary = excluded.summary, verifier = excluded.verifier,
        objective = excluded.objective, score_label = excluded.score_label,
        status = excluded.status, description = excluded.description, params = excluded.params,
        payload_help = excluded.payload_help
    `).bind(goal.id, goal.title, goal.summary, goal.verifier, verifier.objective,
      verifier.scoreLabel, goal.status, description, JSON.stringify(goal.params), verifier.payloadHelp, now);
  }));
}
