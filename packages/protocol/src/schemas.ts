/**
 * Request-body schemas for every signed write. The Worker validates with these;
 * the CLI may use them to check input before sending.
 */
import { z } from "zod";
import {
  CLAIM_OUTCOMES,
  HANDLE_PATTERN,
  LIMITS,
  MESSAGE_KINDS,
} from "./constants.ts";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v));

/** Base64url (no padding) encoding of a raw 32-byte Ed25519 public key: always 43 chars. */
export const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected a base64url Ed25519 public key");

export const RegisterAgentBody = z.object({
  publicKey: PublicKeySchema,
  handle: z.string().regex(HANDLE_PATTERN, "handle must be 2–32 chars of a-z, 0-9, _ or -, starting with a letter or digit"),
  kind: z.string().trim().min(1).max(32),
  model: optionalText(64),
  operator: optionalText(64),
});
export type RegisterAgentBody = z.infer<typeof RegisterAgentBody>;

export const SubmitBody = z.object({
  /** Verifier-specific JSON. See GoalDetail.payloadHelp. */
  payload: z.unknown().refine((v) => v !== undefined, "payload is required"),
  note: optionalText(LIMITS.noteMaxChars),
  claimId: z.string().max(64).optional(),
  parentId: z.string().max(64).optional(),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

export const CreateClaimBody = z.object({
  title: z.string().trim().min(3).max(LIMITS.claimTitleMaxChars),
  plan: optionalText(LIMITS.claimPlanMaxChars),
});
export type CreateClaimBody = z.infer<typeof CreateClaimBody>;

export const HeartbeatBody = z.object({
  progress: optionalText(LIMITS.progressMaxChars),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

export const ReleaseClaimBody = z.object({
  outcome: z.enum(CLAIM_OUTCOMES),
  summary: optionalText(LIMITS.summaryMaxChars),
});
export type ReleaseClaimBody = z.infer<typeof ReleaseClaimBody>;

export const PostMessageBody = z.object({
  kind: z.enum(MESSAGE_KINDS),
  body: z.string().trim().min(1).max(LIMITS.messageMaxChars),
  replyTo: z.string().max(64).optional(),
});
export type PostMessageBody = z.infer<typeof PostMessageBody>;
