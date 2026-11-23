import { DurableObject } from "cloudflare:workers";
import type { FeedEvent, LiveFrame } from "@idle-hands/protocol";
import { eventsBetween, latestSequence } from "./events.ts";
import { isoTime, type WorkerBindings } from "./http.ts";

interface SocketState {
  goalId: string | null;
  latestSeq: number;
}

export class LiveHub extends DurableObject<WorkerBindings> {
  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const goalId = new URL(request.url).searchParams.get("goalId");
      const latestSeq = await latestSequence(this.env.DB);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [goalId ?? "*"]);
      pair[1].serializeAttachment({ goalId, latestSeq } satisfies SocketState);
      const hello: LiveFrame = { type: "hello", latestSeq, serverTime: isoTime() };
      pair[1].send(JSON.stringify(hello));
      return new Response(null, {
        status: 101, webSocket: pair[0], headers: { "Access-Control-Allow-Origin": "*" },
      });
    });
  }

  async publish(events: FeedEvent[]): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const sockets = this.ctx.getWebSockets().map((socket) => ({
        socket, state: socket.deserializeAttachment() as SocketState,
      }));
      if (sockets.length === 0 || events.length === 0) return;

      const through = Math.max(...events.map(({ seq }) => seq));
      let after = sockets.reduce((min, { state }) => Math.min(min, state.latestSeq), through);
      if (after >= through) return;

      // RPCs can arrive out of commit order. Fill gaps from D1 before sending a higher seq.
      const ordered = events.filter(({ seq }) => seq > after).sort((a, b) => a.seq - b.seq);
      const contiguous = ordered.every(({ seq }, index) => seq === after + index + 1);
      while (after < through) {
        const batch = contiguous ? ordered : await eventsBetween(this.env.DB, after, through);
        if (batch.length === 0) break;
        for (const event of batch) {
          const frame: LiveFrame = { type: "event", event };
          const message = JSON.stringify(frame);
          for (const { socket, state } of sockets) {
            if (event.seq <= state.latestSeq) continue;
            state.latestSeq = event.seq;
            if (state.goalId !== null && state.goalId !== event.goalId) continue;
            try {
              socket.send(message);
            } catch {
              socket.close(1011, "Could not deliver event");
            }
          }
          after = event.seq;
        }
        for (const { socket, state } of sockets) socket.serializeAttachment(state);
      }
    });
  }
}
