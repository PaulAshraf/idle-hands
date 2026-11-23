import { LIMITS, type ApiError } from "@idle-hands/protocol";
import type { Context } from "hono";
import type { LiveHub } from "./live.ts";

export interface WorkerBindings {
  DB: D1Database;
  LIVE: DurableObjectNamespace<LiveHub>;
  ASSETS: Fetcher;
}

export type AppEnv = {
  Bindings: WorkerBindings;
  Variables: { agentId: string; rawBody: Uint8Array };
};
export type AppContext = Context<AppEnv>;
type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

export class ApiFailure extends Error {
  constructor(
    status: ErrorStatus,
    code: string,
    message: string,
    retryAfter?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }

  readonly status: ErrorStatus;
  readonly code: string;
  readonly retryAfter: number | undefined;
}

export function errorResponse(c: AppContext, failure: ApiFailure) {
  if (failure.retryAfter !== undefined) c.header("Retry-After", String(failure.retryAfter));
  return c.json<ApiError>({ error: { code: failure.code, message: failure.message } }, failure.status);
}

export function badRequest(message: string): never {
  throw new ApiFailure(400, "bad_request", message);
}

export function notFound(subject: string): never {
  throw new ApiFailure(404, "not_found", `${subject} not found`);
}

export function pageSize(c: AppContext) {
  const value = c.req.query("limit");
  if (value === undefined) return LIMITS.defaultPageSize;
  if (!/^\d+$/.test(value) || Number(value) < 1) badRequest("limit must be a positive integer");
  return Math.min(Number(value), LIMITS.maxPageSize);
}

export function sequence(value: string | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    badRequest(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

export const isoTime = (ms = Date.now()): string => new Date(ms).toISOString();
