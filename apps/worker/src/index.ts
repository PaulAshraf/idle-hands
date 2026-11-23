import { AUTH_HEADERS, LIMITS } from "@idle-hands/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { limitBody } from "./auth.ts";
import { broadcast, rowEvent } from "./events.ts";
import { syncGoals } from "./goals.ts";
import { ApiFailure, errorResponse, isoTime, notFound, type AppEnv, type WorkerBindings } from "./http.ts";
import { reads } from "./reads.ts";
import { pruneRegistrationAttempts, writes } from "./writes.ts";

export { LiveHub } from "./live.ts";

const app = new Hono<AppEnv>();
const api = new Hono<AppEnv>();
let goalsSynced = false;

api.use("*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
      c.header("Access-Control-Allow-Origin", "*");
    }
  }
  await next();
  if (c.req.method === "GET" && c.res.status !== 101) c.res.headers.set("Access-Control-Allow-Origin", "*");
});
api.options("*", (c) => {
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", ["Content-Type", ...Object.values(AUTH_HEADERS)].join(", "));
  return c.body(null, 204);
});
api.use("*", limitBody);
const ensureGoals: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!goalsSynced) {
    await syncGoals(c.env.DB, isoTime());
    goalsSynced = true;
  }
  await next();
};
api.use("/goals/*", ensureGoals);
api.use("/stats", ensureGoals);
api.route("/", reads);
api.route("/", writes);
app.route("/api", api);
app.all("/api", () => notFound("Endpoint"));
app.all("/api/*", () => notFound("Endpoint"));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  if (error instanceof ApiFailure) return errorResponse(c, error);
  console.error(error.stack ?? error);
  return errorResponse(c, new ApiFailure(500, "internal", "Internal server error"));
});

async function sweep(env: WorkerBindings, ctx: ExecutionContext) {
  const { DB } = env;
  const now = Date.now();
  const time = isoTime(now);
  await syncGoals(DB, time);
  goalsSynced = true;
  await DB.batch([
    DB.prepare("DELETE FROM nonces WHERE created_at < ?").bind(now - LIMITS.nonceTtlMs),
    pruneRegistrationAttempts(DB, now),
  ]);

  const expired = `id IN (
    SELECT id FROM claims WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at, id LIMIT ${LIMITS.maxPageSize}
  )`;
  for (;;) {
    const [events, updated] = await DB.batch([
      rowEvent(DB, "claim.updated", time, expired, [time], { status: "expired" }),
      DB.prepare(`UPDATE claims SET status = 'expired' WHERE ${expired}`).bind(time),
    ]);
    broadcast(env, ctx, [events!]);
    if (updated!.meta.changes < LIMITS.maxPageSize) break;
  }
}

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweep(env, ctx));
  },
} satisfies ExportedHandler<WorkerBindings>;
