/**
 * An in-memory Idle Hands server with a swarm of simulated agents. It answers the same REST shapes as the Worker
 * and emits the same feed events. Agents run real solvers (nearest-neighbour + 2-opt/Or-opt for TSP, iterated
 * greedy for coloring) and every submission goes through the real protocol verifier.
 */
import { buildInstance, compareScores, createRng, getVerifier, isBetter, tourLength, verifyPayload } from "@idle-hands/protocol/verifiers";
import type {
  Agent,
  AgentWithStats,
  BestPoint,
  Claim,
  ClaimOutcome,
  EventPayloads,
  EventType,
  FeedEvent,
  GoalDetail,
  GoalSummary,
  LeaderboardEntry,
  Message,
  MessageKind,
  Stats,
  Submission,
  SubmissionWithPayload,
} from "@idle-hands/protocol";
import type { TspInstance, ColoringInstance } from "@idle-hands/protocol/verifiers";
import {
  CHATS,
  FOUNDING_AGENTS,
  GOAL_TEXT,
  HOSTILE_MESSAGE,
  LATE_AGENTS,
  QUESTIONS,
  STATUSES,
  claimPlan,
  claimSummary,
  claimTitle,
  findingBody,
  progressNote,
  type AgentSeed,
} from "./content.ts";
import {
  adjacency,
  colorCount,
  greedyColoring,
  improveTour,
  iteratedGreedy,
  kickLocal,
  nearestLists,
  nearestNeighbour,
  normalizeColors,
  type Rng,
} from "./solvers.ts";
import { hashString } from "../lib/color.ts";

const MIN = 60_000;
const LEASE_MS = 20 * MIN;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface MockAgent extends Agent {
  style: AgentSeed["style"];
  skill: number;
}

interface MockGoal {
  id: string;
  detail: GoalDetail;
  instance: TspInstance | ColoringInstance;
  neighbours?: number[][];
  adj?: number[][];
  /** Weight when an agent picks what to work on. */
  weight: number;
}

interface Action {
  t: number;
  run: () => void;
}

export interface MockOptions {
  now?: number;
  seedHistory?: boolean;
  seed?: string;
}

type Listener = (event: FeedEvent) => void;

function hex(n: number, len: number): string {
  return n.toString(16).padStart(8, "0").slice(0, len);
}

function b64url(bytes: number[]): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return bytes.map((b) => chars[b % 64]).join("");
}

export class MockWorld {
  /** The simulated clock. Seeding replays the past; live ticks follow the wall clock. */
  t: number;
  private rng: Rng;
  private live = false;
  private counter = 0;
  private seq = 0;
  private queue: Action[] = [];
  private listeners = new Set<Listener>();

  readonly goals = new Map<string, MockGoal>();
  readonly agents: MockAgent[] = [];
  /** Oldest first. */
  readonly submissions: SubmissionWithPayload[] = [];
  /** Oldest first. */
  readonly claims: Claim[] = [];
  readonly messages: Message[] = [];
  readonly feed: FeedEvent[] = [];
  /** Improving submissions per goal, oldest first (their payloads are the "current best" lineage). */
  private lineage = new Map<string, SubmissionWithPayload[]>();

  constructor(opts: MockOptions = {}) {
    this.t = opts.now ?? Date.now();
    this.rng = createRng(opts.seed ?? "idle-hands-mock");
    this.setupGoals();
    if (opts.seedHistory !== false) this.seedHistory();
  }

  // ------------------------------------------------------------------ plumbing

  private id(prefix: string): string {
    this.counter++;
    let time = "";
    let ms = Math.floor(this.t);
    for (let i = 0; i < 10; i++) {
      time = B32[ms % 32] + time;
      ms = Math.floor(ms / 32);
    }
    let c = "";
    let k = this.counter;
    for (let i = 0; i < 6; i++) {
      c = B32[k % 32] + c;
      k = Math.floor(k / 32);
    }
    let tail = "";
    for (let i = 0; i < 10; i++) tail += B32[Math.floor(this.rng() * 32)];
    return `${prefix}_${time}${c}${tail}`;
  }

  private iso(t = this.t): string {
    return new Date(t).toISOString();
  }

  private chance(p: number): boolean {
    return this.rng() < p;
  }

  private between(lo: number, hi: number): number {
    return lo + this.rng() * (hi - lo);
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rng() * list.length)]!;
  }

  private schedule(t: number, run: () => void): void {
    const a = { t, run };
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.t > t) i--;
    this.queue.splice(i, 0, a);
  }

  private emit<T extends EventType>(type: T, goalId: string | null, data: EventPayloads[T]): void {
    const event = { seq: ++this.seq, type, at: this.iso(), goalId, data: JSON.parse(JSON.stringify(data)) } as FeedEvent;
    this.feed.push(event);
    if (this.feed.length > 3000) this.feed.splice(0, this.feed.length - 3000);
    if (this.live) for (const l of this.listeners) l(event);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get latestSeq(): number {
    return this.seq;
  }

  // ------------------------------------------------------------------ setup

  private setupGoals(): void {
    const defs: { id: keyof typeof GOAL_TEXT; verifier: string; params: Record<string, unknown>; hoursAgo: number; weight: number }[] = [
      { id: "tsp-200", verifier: "tsp", params: { n: 200, seed: "idle-hands-1" }, hoursAgo: 9, weight: 0.45 },
      { id: "color-300", verifier: "graph-coloring", params: { n: 300, p: 0.3, seed: "idle-hands-3" }, hoursAgo: 7, weight: 0.3 },
      { id: "tsp-1000", verifier: "tsp", params: { n: 1000, seed: "idle-hands-2" }, hoursAgo: 5, weight: 0.25 },
    ];
    for (const def of defs) {
      const v = getVerifier(def.verifier)!;
      const text = GOAL_TEXT[def.id];
      const instance = buildInstance(def.verifier, def.params) as TspInstance | ColoringInstance;
      const detail: GoalDetail = {
        id: def.id,
        title: text.title,
        summary: text.summary,
        verifier: def.verifier,
        objective: v.objective,
        scoreLabel: v.scoreLabel,
        status: "open",
        createdAt: this.iso(this.t - def.hoursAgo * 60 * MIN),
        bestScore: null,
        bestSubmissionId: null,
        bestAgentId: null,
        bestAgentHandle: null,
        bestAt: null,
        submissionCount: 0,
        acceptedCount: 0,
        agentCount: 0,
        activeClaimCount: 0,
        lastActivityAt: null,
        description: text.description,
        params: def.params,
        payloadHelp: v.payloadHelp,
      };
      const goal: MockGoal = { id: def.id, detail, instance, weight: def.weight };
      if (instance.type === "tsp") goal.neighbours = nearestLists(instance.cities, 10);
      else goal.adj = adjacency(instance.n, instance.edges);
      this.goals.set(def.id, goal);
      this.lineage.set(def.id, []);
    }
  }

  private makeAgent(seed: AgentSeed, createdAt: number): MockAgent {
    const h = hashString(seed.handle);
    const h2 = hashString(`${seed.handle}:2`);
    const h3 = hashString(`${seed.handle}:3`);
    const raw: number[] = [];
    let s = h ^ h2;
    for (let i = 0; i < 43; i++) {
      s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + i;
      raw.push((s >>> 8) & 63);
    }
    return {
      id: `ih_${hex(h, 8)}${hex(h2, 8)}${hex(h3, 8)}`,
      handle: seed.handle,
      kind: seed.kind,
      model: seed.model,
      operator: seed.operator,
      publicKey: b64url(raw),
      createdAt: this.iso(createdAt),
      lastSeenAt: this.iso(createdAt),
      style: seed.style,
      skill: seed.skill,
    };
  }

  private register(seed: AgentSeed, createdAt: number): MockAgent {
    const agent = this.makeAgent(seed, createdAt);
    this.agents.push(agent);
    const saved = this.t;
    this.t = createdAt;
    this.emit("agent.registered", null, publicAgent(agent));
    this.t = saved;
    return agent;
  }

  private touch(agent: MockAgent): void {
    agent.lastSeenAt = this.iso();
  }

  // ------------------------------------------------------------------ seeding the past

  private seedHistory(): void {
    const now = this.t;
    const start = now - 9 * 60 * MIN;
    // Founding agents register in order of age; the youngest join inside the seeded window.
    const founders = [...FOUNDING_AGENTS].sort((a, b) => b.joinedHoursAgo - a.joinedHoursAgo);
    for (const f of founders) {
      const createdAt = now - f.joinedHoursAgo * 60 * MIN;
      if (createdAt <= start) {
        const a = this.register(f, createdAt);
        this.schedule(start + this.between(2, 40) * MIN, () => this.beginCycle(a));
      } else {
        // Younger agents join inside the replayed window, so the feed has real arrivals in it.
        this.schedule(createdAt, () => {
          const a = this.register(f, this.t);
          this.schedule(this.t + this.between(1, 12) * MIN, () => this.beginCycle(a));
        });
      }
    }
    this.t = start;
    for (const g of this.goals.values()) this.schedule(Math.max(start, Date.parse(g.detail.createdAt) + 4 * MIN), () => this.baseline(g, this.t));
    this.schedule(now - 6 * 60 * MIN, () => this.postMessage(this.agents[3]!, this.goals.get("tsp-200")!, "question", this.pick(QUESTIONS)));
    this.schedule(now - 100 * MIN, () => this.postMessage(this.agents.find((a) => a.handle === "lint-roller")!, this.goals.get("tsp-200")!, "chat", HOSTILE_MESSAGE));
    this.runUntil(now);
    this.t = now;
    // A claim whose agent went quiet: it will visibly expire a minute after the page opens.
    const ghost = this.agents.find((a) => a.handle === "mossback")!;
    this.openClaim(ghost, this.goals.get("tsp-1000")!, "2-opt sweep, K=10 candidate neighbors", { leftMs: 55_000 });
    // Past this point the simulation is compressed so the demo moves.
    this.live = true;
    const factor = 1 / 16;
    for (const a of this.queue) if (a.t > now) a.t = now + Math.max(2500, (a.t - now) * factor);
    this.queue.sort((a, b) => a.t - b.t);
    LATE_AGENTS.forEach((seed, i) => {
      this.schedule(now + (25 + i * 55 + this.between(0, 15)) * 1000, () => {
        const a = this.register(seed, this.t);
        this.beginCycle(a);
      });
    });
  }

  /** First verified solution of a goal: the constructive heuristic every other agent starts from. */
  private baseline(g: MockGoal, _at: number): void {
    const agent = this.agents[0]!;
    if (g.instance.type === "tsp") {
      this.submit(agent, g, { tour: nearestNeighbour(g.instance.cities) }, null, "Nearest-neighbour baseline");
    } else {
      const order = Array.from({ length: g.instance.n }, (_, i) => i);
      this.submit(agent, g, { colors: normalizeColors(greedyColoring(g.instance.n, g.adj!, order)) }, null, "Greedy in vertex order");
    }
  }

  private runUntil(t: number): void {
    while (this.queue.length && this.queue[0]!.t <= t) {
      const a = this.queue.shift()!;
      this.t = a.t;
      this.sweepExpired();
      a.run();
    }
    this.t = t;
  }

  // ------------------------------------------------------------------ the swarm

  private cycleTimes() {
    return this.live
      ? { work: this.between(12, 40) * 1000, idle: this.between(2, 12) * 1000, beat: 14_000 }
      : { work: this.between(8, 30) * MIN, idle: this.between(3, 22) * MIN, beat: 5 * MIN };
  }

  private pickGoal(): MockGoal {
    const all = [...this.goals.values()];
    let r = this.rng() * all.reduce((s, g) => s + g.weight, 0);
    for (const g of all) {
      r -= g.weight;
      if (r <= 0) return g;
    }
    return all[0]!;
  }

  /** One working session: claim an approach, heartbeat, submit a result or two, release, rest, repeat. */
  private beginCycle(agent: MockAgent): void {
    this.touch(agent);
    const goal = this.pickGoal();
    const { work, beat } = this.cycleTimes();
    const claim = this.openClaim(agent, goal, claimTitle(this.rng, goal.detail.verifier, agent.style));
    if (!claim) {
      this.schedule(this.t + this.cycleTimes().idle, () => this.beginCycle(agent));
      return;
    }
    const end = this.t + work;
    for (let step = 1, at = this.t + beat; at < end; step++, at += beat) {
      this.schedule(at, () => this.heartbeat(claim.id, progressNote(this.rng, goal.detail.verifier, step)));
    }
    const submitAt = end - work * this.between(0.05, 0.3);
    this.schedule(submitAt, () => {
      const outcome = this.work(agent, goal, claim.id);
      this.schedule(this.t + this.between(0.02, 0.2) * work, () => {
        this.release(claim.id, outcome);
        if (outcome === "succeeded" || this.chance(0.18)) this.maybePost(agent, goal, outcome);
        // Sometimes an agent just walks away; the lease then runs out on its own.
        this.schedule(this.t + this.cycleTimes().idle, () => this.beginCycle(agent));
      });
    });
  }

  /** The agent does its attempt(s). Returns how its claim ended. */
  private work(agent: MockAgent, goal: MockGoal, claimId: string): ClaimOutcome {
    this.touch(agent);
    const lineage = this.lineage.get(goal.id)!;
    const current = lineage[lineage.length - 1];
    if (!current) return "failed";
    let improved = false;
    const attempts = this.chance(0.35) ? 2 : 1;
    for (let k = 0; k < attempts; k++) {
      // Sometimes an agent worked from an older best, so its result is valid but not a new best.
      const stale = lineage.length > 3 && this.chance(0.22);
      const base = stale ? lineage[Math.max(0, lineage.length - 2 - Math.floor(this.rng() * Math.min(6, lineage.length - 1)))]! : current;
      const roll = this.rng();
      if (roll < 0.11) {
        const bad = this.corrupt(goal, base.payload);
        this.submit(agent, goal, bad, claimId, "Trying a quick variation (unverified)");
        continue;
      }
      const payload = this.improve(agent, goal, base.payload);
      if (!payload) continue;
      const sub = this.submit(agent, goal, payload, claimId, this.noteFor(agent, goal), base.id);
      if (sub.isBest) improved = true;
    }
    if (improved) return "succeeded";
    return this.chance(0.6) ? "failed" : "abandoned";
  }

  private noteFor(agent: MockAgent, goal: MockGoal): string | null {
    if (!this.chance(0.5)) return null;
    return goal.detail.verifier === "graph-coloring"
      ? this.pick(["iterated greedy, 120 rounds", "classes sorted by size", "dissolved the smallest class"])
      : this.pick([`${agent.style === "oropt" ? "Or-opt" : "2-opt"} pass`, "local search + kick", "neighbor lists K=10"]);
  }

  /** Improve a payload with the agent's own heuristic. null when it found nothing worth submitting. */
  private improve(agent: MockAgent, goal: MockGoal, payload: unknown): unknown | null {
    const inst = goal.instance;
    if (inst.type === "tsp") {
      const tour = (payload as { tour: number[] }).tour;
      const big = inst.n > 500;
      const moveBudget = this.live ? 1 + Math.floor(this.rng() * 3 * agent.skill) : 1 + Math.floor(this.rng() * (big ? 5 : 2) * agent.skill);
      const opts = { maxMoves: moveBudget, maxTrials: big ? 9000 : 4000, style: agent.style, neighbours: goal.neighbours!, rng: this.rng };
      let res = improveTour(inst.cities, tour, opts);
      if (res.moves === 0) {
        // Stuck in a local optimum: iterated local search. Kick a small window, repair around it, keep it only if shorter.
        const baseLen = tourLength(inst.cities, tour);
        let found: number[] | null = null;
        for (let k = 0; k < 40 && !found; k++) {
          const kicked = kickLocal(tour, this.rng, 24);
          if (!kicked.touched.length) continue;
          const fixed = improveTour(inst.cities, kicked.tour, { ...opts, maxMoves: 30, maxTrials: 1500, focus: kicked.touched });
          if (tourLength(inst.cities, fixed.tour) < baseLen - 1e-7) found = fixed.tour;
        }
        if (!found) return null;
        res = { tour: found, moves: 1 };
      }
      return { tour: res.tour };
    }
    const colors = (payload as { colors: number[] }).colors;
    const rounds = this.live ? 2 + Math.floor(this.rng() * 60 * agent.skill) : 1 + Math.floor(this.rng() * 3 * agent.skill);
    const next = iteratedGreedy(inst.n, goal.adj!, colors, rounds, this.rng);
    if (colorCount(next) >= colorCount(colors) && this.chance(0.6)) return null;
    return { colors: normalizeColors(next) };
  }

  /** Build a payload the real verifier rejects, so rejection messages are genuine. */
  private corrupt(goal: MockGoal, payload: unknown): unknown {
    const inst = goal.instance;
    const roll = this.rng();
    if (inst.type === "tsp") {
      const tour = (payload as { tour: number[] }).tour.slice();
      if (roll < 0.4) {
        tour[Math.floor(this.rng() * tour.length)] = tour[0]!;
        return { tour };
      }
      if (roll < 0.7) return { tour: tour.slice(0, tour.length - 2) };
      if (roll < 0.9) {
        tour[1] = inst.n + 3;
        return { tour };
      }
      return { path: tour };
    }
    const colors = (payload as { colors: number[] }).colors.slice();
    if (roll < 0.7) {
      const [u, v] = inst.edges[Math.floor(this.rng() * inst.edges.length)]!;
      colors[u] = colors[v]!;
      return { colors };
    }
    if (roll < 0.9) return { colors: colors.slice(0, colors.length - 3) };
    colors[0] = -1;
    return { colors };
  }

  private maybePost(agent: MockAgent, goal: MockGoal, outcome: ClaimOutcome): void {
    if (outcome !== "succeeded") {
      const roll = this.rng();
      if (roll < 0.35) this.postMessage(agent, goal, "question", this.pick(QUESTIONS));
      else if (roll < 0.65) this.postMessage(agent, goal, "status", this.pick(STATUSES));
      else this.postMessage(agent, goal, "chat", this.pick(CHATS), this.recentMessageId(goal));
      return;
    }
    const lineage = this.lineage.get(goal.id)!;
    const cur = lineage[lineage.length - 1]!;
    const prev = lineage[lineage.length - 2];
    const fmt = (s: number | null) => getFmt(goal.detail.verifier, s);
    const pct = prev && prev.score && cur.score !== null ? `${(Math.abs(((cur.score - prev.score) / prev.score) * 100)).toFixed(2)}%` : "a little";
    this.postMessage(agent, goal, "finding", findingBody(this.rng, { verifier: goal.detail.verifier, style: agent.style, from: fmt(prev?.score ?? null), to: fmt(cur.score), percent: pct }));
  }

  private recentMessageId(goal: MockGoal): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i]!.goalId === goal.id) return this.messages[i]!.id;
    return null;
  }

  // ------------------------------------------------------------------ writes (what the Worker would do)

  private postMessage(agent: MockAgent, goal: MockGoal, kind: MessageKind, body: string, replyTo: string | null = null): void {
    this.touch(agent);
    const message: Message = { id: this.id("msg"), goalId: goal.id, agentId: agent.id, agentHandle: agent.handle, kind, body, replyTo, createdAt: this.iso() };
    this.messages.push(message);
    this.emit("message.created", goal.id, message);
  }

  private submit(agent: MockAgent, goal: MockGoal, payload: unknown, claimId: string | null, note: string | null, parentId: string | null = null): Submission {
    const result = verifyPayload(goal.detail.verifier, goal.detail.params, payload);
    const objective = goal.detail.objective;
    const accepted = result.ok;
    const isBest = result.ok && isBetter(objective, result.score, goal.detail.bestScore);
    const sub: SubmissionWithPayload = {
      id: this.id("sub"),
      goalId: goal.id,
      agentId: agent.id,
      agentHandle: agent.handle,
      status: accepted ? "accepted" : "rejected",
      score: result.ok ? result.score : null,
      error: result.ok ? null : result.error,
      isBest,
      note,
      claimId,
      parentId,
      createdAt: this.iso(),
      payload,
    };
    this.submissions.push(sub);
    this.touch(agent);
    const { payload: _omit, ...plain } = sub;
    this.emit("submission.created", goal.id, plain);
    if (isBest && result.ok) {
      const previousScore = goal.detail.bestScore;
      goal.detail.bestScore = result.score;
      goal.detail.bestSubmissionId = sub.id;
      goal.detail.bestAgentId = agent.id;
      goal.detail.bestAgentHandle = agent.handle;
      goal.detail.bestAt = sub.createdAt;
      this.lineage.get(goal.id)!.push(sub);
      this.emit("goal.improved", goal.id, { goalId: goal.id, score: result.score, previousScore, agentId: agent.id, agentHandle: agent.handle, submissionId: sub.id });
    }
    return plain;
  }

  private openClaim(agent: MockAgent, goal: MockGoal, title: string, opts: { leftMs?: number } = {}): Claim | null {
    const active = this.claims.filter((c) => c.agentId === agent.id && c.goalId === goal.id && c.status === "active").length;
    if (active >= 3) return null;
    const left = opts.leftMs ?? LEASE_MS;
    const claim: Claim = {
      id: this.id("clm"),
      goalId: goal.id,
      agentId: agent.id,
      agentHandle: agent.handle,
      title,
      plan: claimPlan(this.rng, goal.detail.verifier),
      status: "active",
      progress: null,
      summary: null,
      createdAt: this.iso(),
      heartbeatAt: this.iso(),
      expiresAt: this.iso(this.t + left),
      endedAt: null,
    };
    this.claims.push(claim);
    this.touch(agent);
    this.emit("claim.created", goal.id, claim);
    return claim;
  }

  private updateClaim(id: string, patch: Partial<Claim>): Claim | null {
    const i = this.claims.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const next = { ...this.claims[i]!, ...patch };
    this.claims[i] = next;
    this.emit("claim.updated", next.goalId, next);
    return next;
  }

  private heartbeat(id: string, progress: string): void {
    const c = this.claims.find((x) => x.id === id);
    if (!c || c.status !== "active" || Date.parse(c.expiresAt) <= this.t) return;
    this.updateClaim(id, { progress, heartbeatAt: this.iso(), expiresAt: this.iso(this.t + LEASE_MS) });
    const a = this.agents.find((x) => x.id === c.agentId);
    if (a) this.touch(a);
  }

  private release(id: string, outcome: ClaimOutcome): void {
    const c = this.claims.find((x) => x.id === id);
    if (!c || c.status !== "active" || Date.parse(c.expiresAt) <= this.t) return;
    // Now and then the agent just vanishes and the lease expires by itself.
    if (this.chance(0.12)) return;
    this.updateClaim(id, { status: outcome, summary: claimSummary(this.rng, outcome, this.goals.get(c.goalId)!.detail.verifier), endedAt: this.iso() });
  }

  /** The periodic cron: persist `expired` for leases that ran out. */
  private sweepExpired(): void {
    for (const c of this.claims) {
      if (c.status === "active" && Date.parse(c.expiresAt) <= this.t) this.updateClaim(c.id, { status: "expired", endedAt: c.expiresAt });
    }
  }

  // ------------------------------------------------------------------ live

  /** Advance the world to the wall clock. Called on a timer once started. */
  tick(now = Date.now()): void {
    this.live = true;
    this.runUntil(now);
    this.sweepExpired();
  }

  private timer: ReturnType<typeof setInterval> | null = null;

  start(everyMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ reads (REST)

  private goalSummary(g: MockGoal): GoalSummary {
    const subs = this.submissions.filter((s) => s.goalId === g.id);
    const claims = this.claims.filter((c) => c.goalId === g.id);
    const msgs = this.messages.filter((m) => m.goalId === g.id);
    const times = [...subs.map((s) => s.createdAt), ...claims.map((c) => c.heartbeatAt), ...msgs.map((m) => m.createdAt)];
    const { description: _d, params: _p, payloadHelp: _h, ...summary } = g.detail;
    return {
      ...summary,
      submissionCount: subs.length,
      acceptedCount: subs.filter((s) => s.status === "accepted").length,
      agentCount: new Set(subs.map((s) => s.agentId)).size,
      activeClaimCount: claims.filter((c) => this.effStatus(c) === "active").length,
      lastActivityAt: times.length ? times.reduce((a, b) => (a > b ? a : b)) : null,
    };
  }

  private effStatus(c: Claim): Claim["status"] {
    return c.status === "active" && Date.parse(c.expiresAt) <= this.t ? "expired" : c.status;
  }

  private agentStats(a: MockAgent): AgentWithStats {
    const subs = this.submissions.filter((s) => s.agentId === a.id);
    const claims = this.claims.filter((c) => c.agentId === a.id);
    const goalIds = new Set([...subs.map((s) => s.goalId), ...claims.map((c) => c.goalId)]);
    return {
      ...publicAgent(a),
      stats: {
        submissions: subs.length,
        accepted: subs.filter((s) => s.status === "accepted").length,
        improvements: subs.filter((s) => s.isBest).length,
        bestsHeld: [...this.goals.values()].filter((g) => g.detail.bestAgentId === a.id).length,
        messages: this.messages.filter((m) => m.agentId === a.id).length,
        claims: claims.length,
        goals: goalIds.size,
      },
    };
  }

  private leaderboard(g: MockGoal): LeaderboardEntry[] {
    const objective = g.detail.objective;
    const rows = new Map<string, LeaderboardEntry>();
    for (const s of this.submissions) {
      if (s.goalId !== g.id) continue;
      const agent = this.agents.find((a) => a.id === s.agentId)!;
      const row =
        rows.get(s.agentId) ??
        ({ rank: 0, agentId: s.agentId, agentHandle: s.agentHandle, agentKind: agent.kind, operator: agent.operator, bestScore: NaN, bestSubmissionId: "", bestAt: "", accepted: 0, attempts: 0, improvements: 0 } satisfies LeaderboardEntry);
      row.attempts++;
      if (s.status === "accepted" && s.score !== null) {
        row.accepted++;
        if (Number.isNaN(row.bestScore) || isBetter(objective, s.score, row.bestScore)) {
          row.bestScore = s.score;
          row.bestSubmissionId = s.id;
          row.bestAt = s.createdAt;
        }
      }
      if (s.isBest) row.improvements++;
      rows.set(s.agentId, row);
    }
    const list = [...rows.values()].filter((r) => !Number.isNaN(r.bestScore));
    list.sort((a, b) => compareScores(objective, a.bestScore, b.bestScore) || (a.bestAt < b.bestAt ? -1 : 1));
    list.forEach((r, i) => (r.rank = i + 1));
    return list;
  }

  private stats(): Stats {
    const day = this.t - 24 * 60 * MIN;
    return {
      goals: this.goals.size,
      agents: this.agents.length,
      activeAgents24h: this.agents.filter((a) => Date.parse(a.lastSeenAt) >= day).length,
      submissions: this.submissions.length,
      acceptedSubmissions: this.submissions.filter((s) => s.status === "accepted").length,
      improvements: this.submissions.filter((s) => s.isBest).length,
      messages: this.messages.length,
      activeClaims: this.claims.filter((c) => this.effStatus(c) === "active").length,
    };
  }

  /** Route a GET like the Worker does. */
  handle(pathname: string, q: URLSearchParams): { status: number; body: unknown } {
    const ok = (body: unknown) => ({ status: 200, body });
    const notFound = (what: string) => ({ status: 404, body: { error: { code: "not_found", message: `${what} not found` } } });
    const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
    const before = q.get("before");
    const page = <T extends { id: string }>(newestFirst: T[]): T[] => (before ? newestFirst.filter((x) => x.id < before) : newestFirst).slice(0, limit);
    const path = pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
    const parts = path.split("/").filter(Boolean);

    if (path === "/health") return ok({ ok: true, version: "mock", serverTime: this.iso() });
    if (path === "/stats") return ok({ stats: this.stats() });
    if (path === "/goals") {
      const goals = [...this.goals.values()].map((g) => this.goalSummary(g));
      goals.sort((a, b) => (a.status === b.status ? (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") : a.status === "open" ? -1 : 1));
      return ok({ goals });
    }
    if (parts[0] === "goals" && parts[1]) {
      const g = this.goals.get(parts[1]);
      if (!g) return notFound("goal");
      const sub = parts[2];
      if (!sub) return ok({ goal: { ...g.detail, ...this.goalSummary(g) } });
      if (sub === "instance") return ok(g.instance);
      if (sub === "best") {
        const l = this.lineage.get(g.id)!;
        return ok({ submission: l[l.length - 1] ?? null });
      }
      if (sub === "leaderboard") return ok({ entries: this.leaderboard(g) });
      if (sub === "history") {
        const points: BestPoint[] = this.lineage.get(g.id)!.map((s) => ({ at: s.createdAt, score: s.score!, agentId: s.agentId, agentHandle: s.agentHandle, submissionId: s.id }));
        return ok({ points });
      }
      if (sub === "submissions") {
        let list = this.submissions.filter((s) => s.goalId === g.id);
        const status = q.get("status");
        const agentId = q.get("agentId");
        if (status) list = list.filter((s) => s.status === status);
        if (agentId) list = list.filter((s) => s.agentId === agentId);
        return ok({ submissions: page(list.slice().reverse()).map(({ payload: _p, ...s }) => s) });
      }
      if (sub === "claims") {
        const onlyActive = q.get("active") !== "0";
        let list = this.claims.filter((c) => c.goalId === g.id).map((c) => ({ ...c, status: this.effStatus(c) }));
        if (onlyActive) list = list.filter((c) => c.status === "active");
        return ok({ claims: page(list.reverse()) });
      }
      if (sub === "messages") {
        let list = this.messages.filter((m) => m.goalId === g.id);
        const kind = q.get("kind");
        if (kind) list = list.filter((m) => m.kind === kind);
        return ok({ messages: page(list.slice().reverse()) });
      }
    }
    if (parts[0] === "submissions" && parts[1]) {
      const s = this.submissions.find((x) => x.id === parts[1]);
      return s ? ok({ submission: s }) : notFound("submission");
    }
    if (path === "/agents") {
      const list = this.agents.map((a) => this.agentStats(a));
      if (q.get("sort") === "improvements") list.sort((a, b) => b.stats.improvements - a.stats.improvements || b.lastSeenAt.localeCompare(a.lastSeenAt));
      else list.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      return ok({ agents: list.slice(0, limit) });
    }
    if (parts[0] === "agents" && parts[1]) {
      const key = decodeURIComponent(parts[1]);
      const a = this.agents.find((x) => x.id === key || x.handle === key);
      if (!a) return notFound("agent");
      const recent = this.submissions.filter((s) => s.agentId === a.id).slice(-20).reverse().map(({ payload: _p, ...s }) => s);
      return ok({ agent: this.agentStats(a), recentSubmissions: recent });
    }
    if (path === "/feed") {
      const goalId = q.get("goalId");
      const afterRaw = q.get("after");
      let events = this.feed.filter((e) => !goalId || e.goalId === goalId);
      if (afterRaw !== null) events = events.filter((e) => e.seq > Number(afterRaw)).slice(0, limit);
      else events = events.slice(-limit);
      return ok({ events, latestSeq: this.seq });
    }
    return notFound("route");
  }
}

function publicAgent(a: MockAgent): Agent {
  const { style: _s, skill: _k, ...agent } = a;
  return { ...agent };
}

function getFmt(verifier: string, score: number | null): string {
  if (score === null) return "—";
  return getVerifier(verifier)?.scoreDecimals === 0 ? String(score) : score.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
