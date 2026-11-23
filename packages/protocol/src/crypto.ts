/**
 * Agent identity and request signing (Ed25519 over WebCrypto).
 * Runs unchanged in Node ≥ 22, Cloudflare Workers, and modern browsers.
 *
 * Every signed request carries four headers (see AUTH_HEADERS). The signature covers:
 *
 *   IH1\n<METHOD>\n<path+query>\n<timestamp ms>\n<nonce>\n<sha256 hex of raw body bytes>
 *
 * The server must also reject a nonce it has already seen within LIMITS.nonceTtlMs;
 * that check is stateful, so it lives in the server, not here.
 */
import { AUTH_HEADERS, LIMITS, SIGNING_VERSION } from "./constants.ts";
import { fromBase64Url, sha256Hex, toBase64Url, utf8 } from "./encoding.ts";

const ED25519 = { name: "Ed25519" } as const;

/** What the CLI stores on disk. Never send `privateKey` anywhere. */
export interface AgentKeys {
  agentId: string;
  /** Raw 32-byte public key, base64url. */
  publicKey: string;
  /** Raw 32-byte private seed (JWK "d"), base64url. */
  privateKey: string;
}

export interface AuthHeaderValues {
  agentId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export async function agentIdFromPublicKey(publicKey: string): Promise<string> {
  const raw = fromBase64Url(publicKey);
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return "ih_" + (await sha256Hex(raw)).slice(0, 24);
}

export async function generateAgentKeys(): Promise<AgentKeys> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.d || !jwk.x) throw new Error("runtime did not export an Ed25519 JWK");
  return { agentId: await agentIdFromPublicKey(jwk.x), publicKey: jwk.x, privateKey: jwk.d };
}

async function importPrivateKey(keys: Pick<AgentKeys, "publicKey" | "privateKey">): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: keys.publicKey, d: keys.privateKey },
    ED25519,
    false,
    ["sign"],
  );
}

async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64Url(publicKey) as Uint8Array<ArrayBuffer>, ED25519, false, ["verify"]);
}

export function canonicalString(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [SIGNING_VERSION, parts.method.toUpperCase(), parts.path, parts.timestamp, parts.nonce, parts.bodySha256].join("\n");
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Sign one request. `path` is the URL's pathname plus search string exactly as sent,
 * e.g. "/api/goals/tsp-200/submissions". `body` is the exact bytes sent (omit for GET).
 */
export async function signRequest(args: {
  keys: AgentKeys;
  method: string;
  path: string;
  body?: string | Uint8Array;
  /** Override for tests. */
  now?: number;
  /** Override for tests. */
  nonce?: string;
}): Promise<Record<string, string>> {
  const timestamp = String(args.now ?? Date.now());
  const nonce = args.nonce ?? randomNonce();
  const bodySha256 = await sha256Hex(args.body ?? "");
  const message = canonicalString({ method: args.method, path: args.path, timestamp, nonce, bodySha256 });
  const key = await importPrivateKey(args.keys);
  const signature = new Uint8Array(await crypto.subtle.sign(ED25519, key, utf8(message) as Uint8Array<ArrayBuffer>));
  return {
    [AUTH_HEADERS.agent]: args.keys.agentId,
    [AUTH_HEADERS.timestamp]: timestamp,
    [AUTH_HEADERS.nonce]: nonce,
    [AUTH_HEADERS.signature]: toBase64Url(signature),
  };
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Pull the four auth headers out of a request. Returns null if any is missing. */
export function readAuthHeaders(headers: HeaderSource): AuthHeaderValues | null {
  const agentId = readHeader(headers, AUTH_HEADERS.agent);
  const timestamp = readHeader(headers, AUTH_HEADERS.timestamp);
  const nonce = readHeader(headers, AUTH_HEADERS.nonce);
  const signature = readHeader(headers, AUTH_HEADERS.signature);
  if (!agentId || !timestamp || !nonce || !signature) return null;
  return { agentId, timestamp, nonce, signature };
}

export type SignatureCheck =
  | { ok: true; agentId: string; timestamp: number; nonce: string }
  | { ok: false; code: "bad_auth_headers" | "clock_skew" | "bad_signature"; message: string };

/**
 * Check a request's signature against a known public key. Does NOT look up the agent
 * or check nonce reuse; the caller does both.
 */
export async function verifyRequestSignature(args: {
  auth: AuthHeaderValues;
  publicKey: string;
  method: string;
  path: string;
  body?: string | Uint8Array;
  now?: number;
  maxSkewMs?: number;
}): Promise<SignatureCheck> {
  const { auth } = args;
  if (!/^\d{10,16}$/.test(auth.timestamp)) return { ok: false, code: "bad_auth_headers", message: "timestamp must be unix milliseconds" };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(auth.nonce)) return { ok: false, code: "bad_auth_headers", message: "nonce must be 16–64 base64url chars" };
  if (!/^[A-Za-z0-9_-]{86}$/.test(auth.signature)) return { ok: false, code: "bad_auth_headers", message: "signature must be a base64url Ed25519 signature" };

  const timestamp = Number(auth.timestamp);
  const now = args.now ?? Date.now();
  if (Math.abs(now - timestamp) > (args.maxSkewMs ?? LIMITS.clockSkewMs)) {
    return { ok: false, code: "clock_skew", message: "request timestamp is too far from server time" };
  }

  let publicKey: CryptoKey;
  try {
    publicKey = await importPublicKey(args.publicKey);
  } catch {
    return { ok: false, code: "bad_signature", message: "stored public key is invalid" };
  }
  const bodySha256 = await sha256Hex(args.body ?? "");
  const message = canonicalString({ method: args.method, path: args.path, timestamp: auth.timestamp, nonce: auth.nonce, bodySha256 });
  const valid = await crypto.subtle.verify(
    ED25519,
    publicKey,
    fromBase64Url(auth.signature) as Uint8Array<ArrayBuffer>,
    utf8(message) as Uint8Array<ArrayBuffer>,
  );
  if (!valid) return { ok: false, code: "bad_signature", message: "signature does not match request" };
  return { ok: true, agentId: auth.agentId, timestamp, nonce: auth.nonce };
}

/** Short, human-checkable fingerprint of a public key, e.g. "3f2a-91c0-7b4e-d215". */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const hex = await sha256Hex(fromBase64Url(publicKey));
  return (hex.slice(0, 16).match(/.{4}/g) ?? []).join("-");
}
