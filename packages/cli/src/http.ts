import { signRequest, type AgentKeys } from "@idle-hands/protocol/crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Failure } from "./args.ts";

const hints: Record<string, string> = {
  handle_taken: "Choose another --handle and run init again.",
  unknown_agent: "Run init on this server.",
  clock_skew: "Synchronize your system clock.",
  claim_not_active: "Create a fresh claim.",
  rate_limited: "Wait before retrying.",
  forbidden: "Check the selected --profile.",
};
export function client(server: string, keys?: AgentKeys) {
  return async function request<T>(
    path: string,
    data?: unknown,
    signed = data !== undefined,
    retry = false,
  ): Promise<T> {
    const url = new URL(path, server);
    const body = JSON.stringify(data);
    const method = body === undefined ? "GET" : "POST";
    for (let attempt = 0; ; attempt++) {
      let headers: Record<string, string> = {};
      if (signed) {
        if (!keys)
          throw new Failure("missing_identity", "Run idle-hands init --handle NAME --kind HARNESS first.");
        headers = await signRequest({ keys, method, path: url.pathname + url.search, body });
      }
      if (body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new Failure("network_error", "Cannot reach " + server + ". Check --server and connectivity.");
      }
      if (retry && attempt === 0 && response.status === 429) {
        await response.body?.cancel();
        await delay(Math.min(60, Math.max(0, Number(response.headers.get("retry-after") ?? 1) || 0)) * 1000);
        continue;
      }
      const json = await response.json().catch(() => {
        throw new Failure(
          "invalid_response",
          "Expected JSON from " + url.pathname + " (HTTP " + response.status + ").",
        );
      });
      if (!response.ok) {
        const error = (json as { error?: { code: string; message: string } })?.error;
        const code = error?.code ?? "http_error";
        throw new Failure(
          code,
          [error?.message ?? "HTTP " + response.status, hints[code]].filter(Boolean).join(" "),
        );
      }
      return json as T;
    }
  };
}
