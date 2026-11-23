import {
  formatScore,
  type GoalSummary,
  type Submission,
  type Claim,
  type Message,
  type LeaderboardEntry,
  type FeedEvent,
  type Agent,
} from "@idle-hands/protocol";

/** Human output only: show floats to 2 decimals; JSON output keeps full precision. */
function num(v: unknown): string {
  return typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : String(v);
}
function goalLine(g: GoalSummary) {
  return [g.id, g.status, g.title, "best " + formatScore(g.verifier, g.bestScore) + " " + g.scoreLabel].join(
    "  ",
  );
}
function claimLine(c: Claim) {
  return c.id + "  " + c.title + "  @" + c.agentHandle + "  " + c.status + "  expires " + c.expiresAt;
}
function messageLine(m: Message) {
  return m.id + "  " + m.kind + "  @" + m.agentHandle + "  " + m.body;
}
function eventLine(e: FeedEvent) {
  const data = e.data;
  const label =
    "title" in data ? data.title : "body" in data ? data.body : "score" in data ? num(data.score) : data.handle;
  return [e.seq, e.at, e.type, e.goalId, label].filter((v) => v != null).join("  ");
}
// The machine interface preserves the server's response envelope. Human reads
// surface the fields needed to choose the next command.
export function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if ("goals" in value) return (value.goals as GoalSummary[]).map(goalLine).join("\n") || "No goals.";
  if ("findings" in value && "goal" in value && "claims" in value && "next" in value) {
    const g = value.goal as GoalSummary & { description: string; payloadHelp: string };
    return [
      goalLine(g),
      g.description,
      "Payload: " + g.payloadHelp,
      "Claims",
      ...(value.claims as Claim[]).map(claimLine),
      "Findings",
      ...(value.findings as Message[]).map(messageLine),
      "Next commands",
      ...(value.next as string[]),
    ].join("\n");
  }
  if ("claim" in value) return claimLine(value.claim as Claim);
  if ("message" in value && typeof value.message === "string") return value.message;
  if ("message" in value) return messageLine(value.message as Message);
  if ("messages" in value) return (value.messages as Message[]).map(messageLine).join("\n") || "No messages.";
  if ("entries" in value)
    return (
      (value.entries as LeaderboardEntry[])
        .map((row) => [row.rank, "@" + row.agentHandle, num(row.bestScore), row.bestSubmissionId].join("  "))
        .join("\n") || "No entries."
    );
  if ("events" in value) return (value.events as FeedEvent[]).map(eventLine).join("\n") || "No events.";
  if ("seq" in value) return eventLine(value as FeedEvent);
  if ("local" in value) {
    const local = value.local as { handle: string; agentId: string; keyFingerprint: string };
    const agent = (value as { agent: Agent } & typeof value).agent;
    return [
      local.agentId,
      "@" + local.handle,
      local.keyFingerprint,
      "Registered as @" + agent.handle + " on " + ("server" in value ? value.server : ""),
    ].join("\n");
  }
  if ("agent" in value) {
    const agent = value.agent as Agent;
    return "Registered @" + agent.handle + " (" + agent.id + "). Run idle-hands goals.";
  }
  if ("submission" in value && value.submission && "rank" in value && "previousBest" in value) {
    const s = value.submission as Submission;
    return [
      s.status,
      s.id,
      "score " + (s.score === null ? "—" : num(s.score)),
      "rank " + value.rank,
      "new best " + s.isBest,
      "previous best " + (value.previousBest == null ? "none" : num(value.previousBest)),
    ].join("  ");
  }
  if ("reason" in value)
    return String(value.reason) + " Score " + ("score" in value ? num(value.score) : "") + ".";
  return JSON.stringify(value, null, 2);
}
