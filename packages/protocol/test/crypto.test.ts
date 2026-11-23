import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_HEADERS } from "../src/constants.ts";
import {
  agentIdFromPublicKey,
  canonicalString,
  generateAgentKeys,
  keyFingerprint,
  readAuthHeaders,
  signRequest,
  verifyRequestSignature,
} from "../src/crypto.ts";

test("generated keys derive a stable agent id", async () => {
  const keys = await generateAgentKeys();
  assert.match(keys.agentId, /^ih_[0-9a-f]{24}$/);
  assert.equal(keys.publicKey.length, 43);
  assert.equal(keys.privateKey.length, 43);
  assert.equal(await agentIdFromPublicKey(keys.publicKey), keys.agentId);
  assert.match(await keyFingerprint(keys.publicKey), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
});

test("canonical string layout is fixed", () => {
  assert.equal(
    canonicalString({ method: "post", path: "/api/x?y=1", timestamp: "1", nonce: "n", bodySha256: "h" }),
    "IH1\nPOST\n/api/x?y=1\n1\nn\nh",
  );
});

test("a signed request verifies, and any tampering fails", async () => {
  const keys = await generateAgentKeys();
  const body = JSON.stringify({ payload: { tour: [0, 1, 2] } });
  const path = "/api/goals/tsp-200/submissions";
  const headers = await signRequest({ keys, method: "POST", path, body });
  const auth = readAuthHeaders(new Headers(headers));
  assert.ok(auth);
  assert.equal(auth.agentId, keys.agentId);

  const ok = await verifyRequestSignature({ auth, publicKey: keys.publicKey, method: "POST", path, body });
  assert.equal(ok.ok, true);

  const wrongBody = await verifyRequestSignature({ auth, publicKey: keys.publicKey, method: "POST", path, body: body + " " });
  assert.deepEqual(wrongBody.ok ? null : wrongBody.code, "bad_signature");

  const wrongPath = await verifyRequestSignature({ auth, publicKey: keys.publicKey, method: "POST", path: path + "?x", body });
  assert.equal(wrongPath.ok, false);

  const wrongMethod = await verifyRequestSignature({ auth, publicKey: keys.publicKey, method: "PUT", path, body });
  assert.equal(wrongMethod.ok, false);

  const other = await generateAgentKeys();
  const wrongKey = await verifyRequestSignature({ auth, publicKey: other.publicKey, method: "POST", path, body });
  assert.equal(wrongKey.ok, false);
});

test("GET requests sign an empty body", async () => {
  const keys = await generateAgentKeys();
  const headers = await signRequest({ keys, method: "GET", path: "/api/me" });
  const auth = readAuthHeaders(headers)!;
  const res = await verifyRequestSignature({ auth, publicKey: keys.publicKey, method: "GET", path: "/api/me" });
  assert.equal(res.ok, true);
  const withEmpty = await verifyRequestSignature({ auth, publicKey: keys.publicKey, method: "GET", path: "/api/me", body: "" });
  assert.equal(withEmpty.ok, true);
});

test("stale timestamps are rejected", async () => {
  const keys = await generateAgentKeys();
  const headers = await signRequest({ keys, method: "GET", path: "/api/me", now: Date.now() - 10 * 60_000 });
  const res = await verifyRequestSignature({ auth: readAuthHeaders(headers)!, publicKey: keys.publicKey, method: "GET", path: "/api/me" });
  assert.equal(res.ok ? null : res.code, "clock_skew");
});

test("readAuthHeaders accepts plain records and rejects missing headers", () => {
  assert.equal(readAuthHeaders({}), null);
  const rec = {
    [AUTH_HEADERS.agent]: "ih_x",
    [AUTH_HEADERS.timestamp]: "1",
    [AUTH_HEADERS.nonce]: "n",
    [AUTH_HEADERS.signature]: ["s", "t"],
  };
  assert.deepEqual(readAuthHeaders(rec), { agentId: "ih_x", timestamp: "1", nonce: "n", signature: "s" });
});
