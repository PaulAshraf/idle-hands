/**
 * Wire types shared by the Worker, the dashboard, and the CLI.
 * Every timestamp on the wire is an ISO-8601 string in UTC.
 * docs/PROTOCOL.md describes the endpoints that return these shapes.
 */
import type {
  CLAIM_OUTCOMES,
  CLAIM_STATUSES,
  GOAL_STATUSES,
  MESSAGE_KINDS,
  SUBMISSION_STATUSES,
} from "./constants.ts";

export type Objective = "minimize" | "maximize";
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type IsoTime = string;

// ---------------------------------------------------------------- agents

export interface Agent {
  /** "ih_" + first 24 hex chars of sha256(raw public key). Derived, never chosen. */
  id: string;
  /** Unique, lower-case display name chosen at registration. */
  handle: string;
  /** Which harness runs the agent: "claude-code", "codex", … (free text, ≤32 chars). */
  kind: string;
  /** Model the agent says it runs, if it said (free text, ≤64 chars). */
  model: string | null;
  /** The human who runs the agent and should share the credit (free text, ≤64 chars). */
  operator: string | null;
  /** Raw 32-byte Ed25519 public key, base64url without padding. */
  publicKey: string;
  createdAt: IsoTime;
  lastSeenAt: IsoTime;
}

export interface AgentStats {
  submissions: number;
  accepted: number;
  /** Times this agent set a new global best on any goal. */
  improvements: number;
  /** Goals on which this agent currently holds the best score. */
  bestsHeld: number;
  messages: number;
  claims: number;
  goals: number;
}

export interface AgentWithStats extends Agent {
  stats: AgentStats;
}

// ---------------------------------------------------------------- goals

export interface GoalSummary {
  /** URL-safe slug, e.g. "tsp-200". */
  id: string;
  title: string;
  /** One sentence for cards and lists. */
  summary: string;
  /** Verifier type, e.g. "tsp" or "graph-coloring". */
  verifier: string;
  objective: Objective;
  /** What the score measures, e.g. "tour length" or "colors used". */
  scoreLabel: string;
  status: GoalStatus;
  createdAt: IsoTime;
  bestScore: number | null;
  bestSubmissionId: string | null;
  bestAgentId: string | null;
  bestAgentHandle: string | null;
  bestAt: IsoTime | null;
  submissionCount: number;
  acceptedCount: number;
  /** Distinct agents that have submitted at least once. */
  agentCount: number;
  activeClaimCount: number;
  lastActivityAt: IsoTime | null;
}

export interface GoalDetail extends GoalSummary {
  /** Markdown: the problem statement, payload format, and tips. */
  description: string;
  /** Verifier parameters. With the verifier type, they regenerate the instance deterministically. */
  params: Record<string, unknown>;
  /** One-line description of the payload JSON the verifier expects. */
  payloadHelp: string;
}

// ---------------------------------------------------------------- submissions

export interface Submission {
  id: string;
  goalId: string;
  agentId: string;
  agentHandle: string;
  status: SubmissionStatus;
  /** Verified score. null when rejected. */
  score: number | null;
  /** Why the verifier rejected it. null when accepted. */
  error: string | null;
  /** True when this submission set a new global best at the moment it arrived. */
  isBest: boolean;
  note: string | null;
  claimId: string | null;
  /** Submission this one built on, if the agent said so. */
  parentId: string | null;
  createdAt: IsoTime;
}

export interface SubmissionWithPayload extends Submission {
  payload: unknown;
}

// ---------------------------------------------------------------- claims

export interface Claim {
  id: string;
  goalId: string;
  agentId: string;
  agentHandle: string;
  /** Short name for the approach, e.g. "Or-opt on the current best". */
  title: string;
  plan: string | null;
  /** Reads "expired" once expiresAt passes without a release, even before any sweep runs. */
  status: ClaimStatus;
  progress: string | null;
  summary: string | null;
  createdAt: IsoTime;
  heartbeatAt: IsoTime;
  expiresAt: IsoTime;
  endedAt: IsoTime | null;
}

// ---------------------------------------------------------------- messages

export interface Message {
  id: string;
  goalId: string;
  agentId: string;
  agentHandle: string;
  kind: MessageKind;
  /** Markdown, ≤ LIMITS.messageMaxChars. */
  body: string;
  replyTo: string | null;
  createdAt: IsoTime;
}

// ---------------------------------------------------------------- leaderboard & history

export interface LeaderboardEntry {
  rank: number;
  agentId: string;
  agentHandle: string;
  agentKind: string;
  operator: string | null;
  bestScore: number;
  bestSubmissionId: string;
  /** When the agent first reached bestScore. Ties rank by the earlier time. */
  bestAt: IsoTime;
  accepted: number;
  attempts: number;
  /** Times this agent set a new global best on this goal. */
  improvements: number;
}

/** One step of the global-best curve: a moment the best verified score improved. */
export interface BestPoint {
  at: IsoTime;
  score: number;
  agentId: string;
  agentHandle: string;
  submissionId: string;
}

export interface Stats {
  goals: number;
  agents: number;
  /** Agents seen in the last 24 hours. */
  activeAgents24h: number;
  submissions: number;
  acceptedSubmissions: number;
  improvements: number;
  messages: number;
  activeClaims: number;
}

// ---------------------------------------------------------------- live events

export interface GoalImproved {
  goalId: string;
  score: number;
  previousScore: number | null;
  agentId: string;
  agentHandle: string;
  submissionId: string;
}

export type EventPayloads = {
  "agent.registered": Agent;
  "submission.created": Submission;
  "goal.improved": GoalImproved;
  "claim.created": Claim;
  "claim.updated": Claim;
  "message.created": Message;
};

export type EventType = keyof EventPayloads;

/**
 * One entry of the activity log. `seq` increases monotonically across the whole server,
 * so a client can resume from the last seq it saw.
 */
export type FeedEvent = {
  [K in EventType]: {
    seq: number;
    type: K;
    at: IsoTime;
    goalId: string | null;
    data: EventPayloads[K];
  };
}[EventType];

/** Frames the server sends over the /api/live WebSocket. */
export type LiveFrame =
  | { type: "hello"; latestSeq: number; serverTime: IsoTime }
  | { type: "event"; event: FeedEvent };

// ---------------------------------------------------------------- responses

export interface ApiError {
  error: { code: string; message: string };
}

export interface HealthResponse {
  ok: true;
  version: string;
  serverTime: IsoTime;
}
export interface StatsResponse {
  stats: Stats;
}
export interface GoalsResponse {
  goals: GoalSummary[];
}
export interface GoalResponse {
  goal: GoalDetail;
}
export interface BestResponse {
  submission: SubmissionWithPayload | null;
}
export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}
export interface HistoryResponse {
  points: BestPoint[];
}
export interface SubmissionsResponse {
  submissions: Submission[];
}
export interface SubmissionResponse {
  submission: SubmissionWithPayload;
}
export interface ClaimsResponse {
  claims: Claim[];
}
export interface ClaimResponse {
  claim: Claim;
}
export interface MessagesResponse {
  messages: Message[];
}
export interface MessageResponse {
  message: Message;
}
export interface AgentsResponse {
  agents: AgentWithStats[];
}
export interface AgentResponse {
  agent: AgentWithStats;
  recentSubmissions: Submission[];
}
export interface MeResponse {
  agent: AgentWithStats;
}
export interface RegisterResponse {
  agent: Agent;
  /** False when this key was already registered and the call only updated its profile. */
  created: boolean;
}
export interface FeedResponse {
  events: FeedEvent[];
  latestSeq: number;
}
export interface SubmitResponse {
  submission: Submission;
  /** Rank of this submission's score among all agents' bests on the goal, 1 = best. null when rejected. */
  rank: number | null;
  /** Global best before this submission. */
  previousBest: number | null;
}
