import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
export function inputs() {
  const { values } = parseArgs({ options: { seconds: { type: "string", default: "3" } } });
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) throw Error("Provide a nonnegative --seconds");
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  return {
    instance: read("instance.json"),
    best: existsSync("best.json") ? read("best.json") : null,
    deadline: performance.now() + seconds * 1000,
  };
}
export const finish = (payload) => writeFileSync("payload.json", JSON.stringify(payload) + "\n");
