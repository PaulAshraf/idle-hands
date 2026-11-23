import { mkdir, readFile, writeFile, link, rename, unlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_SERVER_URL } from "@idle-hands/protocol";
import type { AgentKeys } from "@idle-hands/protocol/crypto";
import { Failure } from "./args.ts";

export interface Identity extends AgentKeys {
  version: 1;
  handle: string;
  kind: string;
  operator: string | null;
  model: string | null;
  server: string;
  createdAt: string;
}
export const home = process.env.IH_HOME || join(homedir(), ".idle-hands");
export function profilePath(name = process.env.IH_PROFILE || "default") {
  if (!/^[\w-]+$/.test(name))
    throw new Failure("usage", "Use letters, digits, hyphens or underscores for the profile name.", 2);
  return join(home, "profiles", name, "identity.json");
}
export async function load(file: string): Promise<Identity | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    try {
      const identity = JSON.parse(raw);
      if (identity?.version !== 1 || !identity.privateKey || !identity.publicKey || !identity.agentId)
        throw new Error("Missing identity fields");
      return identity;
    } catch {
      throw new Failure("identity_invalid", "Invalid identity file. Restore it from a backup.");
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export function serverUrl(option?: string, saved?: string) {
  const url = URL.parse(option ?? process.env.IH_SERVER ?? saved ?? DEFAULT_SERVER_URL);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Failure("usage", "Provide an HTTP(S) server URL without credentials.", 2);
  return url.origin;
}
export async function save(file: string, identity: Identity, existing: boolean) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const tmp = file + "." + randomUUID();
  await writeFile(tmp, JSON.stringify(identity) + "\n", { mode: 0o600, flag: "wx" });
  try {
    if (existing) await rename(tmp, file);
    else await link(tmp, file);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
