import { LIMITS, PublicKeySchema } from "@idle-hands/protocol";
import { agentIdFromPublicKey, readAuthHeaders, verifyRequestSignature } from "@idle-hands/protocol/crypto";
import type { MiddlewareHandler } from "hono";
import { ApiFailure, badRequest, isoTime, type AppEnv } from "./http.ts";

export const limitBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tooLarge = () => new ApiFailure(413, "payload_too_large", "Request body exceeds 1 MB");
  const request = c.req.raw;
  if (Number(request.headers.get("Content-Length")) > LIMITS.maxBodyBytes) throw tooLarge();

  // Bound memory use for requests that arrive without a Content-Length.
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > LIMITS.maxBodyBytes) {
          void reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  c.set("rawBody", bytes);
  await next();
};

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    badRequest("Body must be valid UTF-8 JSON");
  }
}

interface BodySchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

export function parseBody<T>(bytes: Uint8Array, schema: BodySchema<T>): T {
  const result = schema.safeParse(parseJson(bytes));
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  badRequest(issue ? `${issue.path.map(String).join(".") || "body"}: ${issue.message}` : "Invalid body");
}

export function authenticate(registration = false): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { DB } = c.env;
    const request = c.req.raw;
    const auth = readAuthHeaders(request.headers);
    if (!auth) throw new ApiFailure(401, "unauthenticated", "Missing authentication headers");
    const body = c.get("rawBody");
    let publicKey: string;

    if (registration) {
      // Registration must decode the public key before the raw body can be authenticated.
      const data = parseJson(body) as { publicKey?: unknown } | null;
      const key = PublicKeySchema.safeParse(data?.publicKey);
      if (!key.success) badRequest(`publicKey: ${key.error.issues[0]?.message}`);
      publicKey = key.data;
      if (await agentIdFromPublicKey(publicKey) !== auth.agentId) {
        throw new ApiFailure(401, "bad_signature", "Agent id does not match the registration public key");
      }
    } else {
      const agent = await DB.prepare("SELECT public_key FROM agents WHERE id = ?")
        .bind(auth.agentId).first<{ public_key: string }>();
      if (!agent) throw new ApiFailure(401, "unknown_agent", "Agent is not registered");
      publicKey = agent.public_key;
    }

    const { pathname, search } = new URL(request.url);
    const check = await verifyRequestSignature({
      auth, publicKey, method: request.method, path: pathname + search, body,
    });
    if (!check.ok) throw new ApiFailure(401, check.code, check.message);

    const now = Date.now();
    const nonce = await DB.prepare(`
      INSERT INTO nonces (agent_id, nonce, created_at) VALUES (?, ?, ?)
      ON CONFLICT(agent_id, nonce) DO UPDATE SET created_at = excluded.created_at
      WHERE nonces.created_at < ?
    `).bind(check.agentId, check.nonce, now, now - LIMITS.nonceTtlMs).run();
    if (nonce.meta.changes === 0) throw new ApiFailure(401, "replayed_nonce", "Nonce has already been used");

    await DB.prepare("UPDATE agents SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?")
      .bind(isoTime(now), check.agentId).run();
    c.set("agentId", check.agentId);
    await next();
  };
}
