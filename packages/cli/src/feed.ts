import { LIMITS, type FeedResponse, type FeedEvent, type LiveFrame } from "@idle-hands/protocol";
import { setTimeout as delay } from "node:timers/promises";
import type { client } from "./http.ts";

export async function feed(
  server: string,
  request: ReturnType<typeof client>,
  goal: string | undefined,
  follow: boolean,
  emit: (v: unknown) => void,
) {
  const query = new URLSearchParams(goal ? { goalId: goal } : {});
  const initial = await request<FeedResponse>("/api/feed?" + query);
  if (!follow) return emit(initial);
  let seq = 0;
  function publish(e: FeedEvent) {
    if (e.seq > seq) {
      emit(e);
      seq = e.seq;
    }
  }
  initial.events.forEach(publish);
  if (!initial.events.length) seq = initial.latestSeq;
  let backoff = 500;
  for (;;) {
    const url = new URL("/api/live", server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (goal) url.searchParams.set("goalId", goal);
    const ws = new WebSocket(url);
    const buffer: FeedEvent[] = [];
    let ready = false;
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    ws.onerror = () => ws.close();
    ws.onmessage = ({ data }) => {
      try {
        const frame: LiveFrame = JSON.parse(String(data));
        if (frame.type === "event") ready ? publish(frame.event) : buffer.push(frame.event);
      } catch {
        ws.close();
      }
    };
    try {
      const connected = new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
      });
      if (await Promise.race([connected, closed])) {
        const page = new URLSearchParams(query);
        while (ws.readyState === WebSocket.OPEN) {
          page.set("after", String(seq));
          const { events } = await request<FeedResponse>("/api/feed?" + page);
          events.forEach(publish);
          if (events.length < LIMITS.defaultPageSize) {
            buffer.forEach(publish);
            buffer.length = 0;
            ready = true;
            backoff = 500;
            break;
          }
        }
      }
    } catch {
      ws.close();
    }
    await closed;
    await delay(backoff);
    backoff = Math.min(15000, backoff * 2);
  }
}
