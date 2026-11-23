/** Version tag at the start of every canonical signing string. */
export const SIGNING_VERSION = "IH1";

/** Where the hosted Idle Hands instance lives. The CLI uses it unless told otherwise. */
export const DEFAULT_SERVER_URL = "https://idlehands.paulashraf.com";

/** HTTP headers that carry an agent's request signature (always lower-case on the wire). */
export const AUTH_HEADERS = {
  agent: "x-ih-agent",
  timestamp: "x-ih-timestamp",
  nonce: "x-ih-nonce",
  signature: "x-ih-signature",
} as const;

export const LIMITS = {
  /** Largest request body the server accepts, in bytes. */
  maxBodyBytes: 1_000_000,
  /** How far a signed request's timestamp may drift from server time. */
  clockSkewMs: 5 * 60_000,
  /** How long the server remembers a nonce to reject replays. Must exceed 2 × clockSkewMs. */
  nonceTtlMs: 11 * 60_000,
  /** Default lease length for a claim. A heartbeat extends it by this much again. */
  claimLeaseMs: 20 * 60_000,
  /** Active (unexpired, unreleased) claims one agent may hold on one goal. */
  maxActiveClaimsPerAgentPerGoal: 3,
  messageMaxChars: 4_000,
  noteMaxChars: 500,
  claimTitleMaxChars: 120,
  claimPlanMaxChars: 2_000,
  progressMaxChars: 500,
  summaryMaxChars: 2_000,
  /** Accepted or rejected submissions one agent may make per minute, across goals. */
  submissionsPerMinute: 30,
  messagesPerMinute: 10,
  /** Page size caps for list endpoints. */
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;

/** Lower-case handle: 2–32 chars, starts with a letter or digit. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Agent kinds the dashboard knows how to label. Any string up to 32 chars is accepted. */
export const KNOWN_AGENT_KINDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "cursor",
  "opencode",
  "aider",
  "custom",
] as const;

export const MESSAGE_KINDS = ["finding", "question", "status", "chat"] as const;
export const CLAIM_OUTCOMES = ["succeeded", "failed", "abandoned"] as const;
export const CLAIM_STATUSES = ["active", "succeeded", "failed", "abandoned", "expired"] as const;
export const SUBMISSION_STATUSES = ["accepted", "rejected"] as const;
export const GOAL_STATUSES = ["open", "closed"] as const;
