import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedEvent, FeedResponse, LiveFrame } from "@idle-hands/protocol";
import { LiveClient, backoffMs, type ConnectionState, type FeedParams, type SocketLike } from "./client.ts";
import { ev, message } from "../../test-utils.ts";

const e = (seq: number): FeedEvent => ev(seq, "message.created", message(`msg_${seq}`));

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: string[] = [];
  closed = false;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  frame(f: LiveFrame | "pong") {
    this.onmessage?.({ data: f === "pong" ? f : JSON.stringify(f) });
  }
  hello(latestSeq = 0) {
    this.frame({ type: "hello", latestSeq, serverTime: new Date().toISOString() });
  }
  event(seq: number) {
    this.frame({ type: "event", event: e(seq) });
  }
  drop() {
    this.onclose?.({});
  }
}

function setup(feed: FeedEvent[] = [], opts: Partial<ConstructorParameters<typeof LiveClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const delivered: { seq: number; replay: boolean }[] = [];
  const states: ConnectionState[] = [];
  const calls: FeedParams[] = [];
  const store = { events: feed };
  const fetchFeed = vi.fn(async (p: FeedParams): Promise<FeedResponse> => {
    calls.push(p);
    const list = p.after !== undefined ? store.events.filter((x) => x.seq > p.after!) : store.events.slice(-(p.limit ?? 50));
    return { events: list.slice(0, p.limit ?? 200), latestSeq: store.events.at(-1)?.seq ?? 0 };
  });
  const client = new LiveClient({
    url: "ws://x/api/live",
    goalId: "g1",
    onEvent: (x, m) => delivered.push({ seq: x.seq, replay: m.replay }),
    onState: (s) => states.push(s),
    fetchFeed,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
    ...opts,
  });
  return { client, sockets, delivered, states, calls, store, fetchFeed };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("backoffMs", () => {
  it("grows exponentially, caps at 30s, and jitters ±20%", () => {
    expect(backoffMs(1, () => 0.5)).toBe(1000);
    expect(backoffMs(2, () => 0.5)).toBe(2000);
    expect(backoffMs(4, () => 0.5)).toBe(8000);
    expect(backoffMs(20, () => 0.5)).toBe(30000);
    expect(backoffMs(1, () => 0)).toBe(800);
    expect(backoffMs(1, () => 1)).toBe(1200);
  });
});

describe("LiveClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("bootstraps with the latest events (as replay) and goes live on hello", async () => {
    const { client, sockets, delivered, states, calls } = setup([e(1), e(2), e(3)]);
    client.start();
    await flush();
    expect(calls[0]).toMatchObject({ goalId: "g1", limit: 50 });
    expect(calls[0]!.after).toBeUndefined();
    expect(delivered).toEqual([1, 2, 3].map((seq) => ({ seq, replay: true })));
    sockets[0]!.hello(3);
    await flush();
    expect(states.at(-1)).toBe("live");
    sockets[0]!.event(4);
    expect(delivered.at(-1)).toEqual({ seq: 4, replay: false });
    expect(client.lastSeq).toBe(4);
  });

  it("de-duplicates events seen over both the backfill and the socket", async () => {
    const { client, sockets, delivered, store } = setup([e(1)]);
    client.start();
    await flush();
    sockets[0]!.hello(1);
    await flush();
    sockets[0]!.event(2);
    sockets[0]!.event(2);
    store.events = [e(1), e(2), e(3)];
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1100);
    sockets[1]!.hello(3);
    await flush();
    expect(delivered.map((d) => d.seq)).toEqual([1, 2, 3]);
  });

  it("backfills the gap with ?after=<lastSeq> after a reconnect", async () => {
    const { client, sockets, delivered, calls, store, states } = setup([e(1), e(2)]);
    client.start();
    await flush();
    sockets[0]!.hello(2);
    await flush();
    sockets[0]!.drop();
    expect(states.at(-1)).toBe("reconnecting");
    store.events = [e(1), e(2), e(3), e(4), e(5)];
    await vi.advanceTimersByTimeAsync(1100);
    expect(sockets).toHaveLength(2);
    sockets[1]!.hello(5);
    await flush();
    expect(calls.at(-1)).toMatchObject({ after: 2, goalId: "g1" });
    expect(delivered.map((d) => d.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(delivered.at(-1)!.replay).toBe(false);
    expect(states.at(-1)).toBe("live");
  });

  it("holds socket events that arrive mid-backfill and delivers them in order without duplicates", async () => {
    const { client, sockets, delivered, store } = setup([e(1)]);
    client.start();
    await flush();
    sockets[0]!.hello(1);
    await flush();
    store.events = [e(1), e(2), e(3)];
    sockets[0]!.hello(3); // triggers a backfill
    sockets[0]!.event(4); // arrives while it is in flight
    await flush();
    expect(delivered.map((d) => d.seq)).toEqual([1, 2, 3, 4]);
  });

  it("pings on an interval and answers silence by reconnecting", async () => {
    const { client, sockets, states } = setup([], { pingIntervalMs: 1000 });
    client.start();
    await flush();
    sockets[0]!.hello(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[0]!.sent).toEqual(["ping"]);
    sockets[0]!.frame("pong");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets[0]!.sent.length).toBe(3);
    // now go quiet for > 2.5 intervals
    await vi.advanceTimersByTimeAsync(4000);
    expect(states.at(-1)).toBe("reconnecting");
    expect(sockets[0]!.closed).toBe(true);
  });

  it("falls back to polling the feed when the socket keeps failing, then recovers", async () => {
    const { client, sockets, delivered, store, states } = setup([e(1)], { pollIntervalMs: 1000, failuresBeforePolling: 2 });
    client.start();
    await flush();
    sockets[0]!.drop();
    await vi.advanceTimersByTimeAsync(1100);
    sockets[1]!.drop();
    expect(states.at(-1)).toBe("polling");
    store.events = [e(1), e(2)];
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered.map((d) => d.seq)).toEqual([1, 2]);
    store.events = [e(1), e(2), e(3)];
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered.map((d) => d.seq)).toEqual([1, 2, 3]);
    // The socket eventually connects: polling stops.
    await vi.advanceTimersByTimeAsync(4000);
    const live = sockets.at(-1)!;
    live.hello(3);
    await flush();
    expect(states.at(-1)).toBe("live");
    const before = delivered.length;
    store.events = [...store.events, e(4)];
    await vi.advanceTimersByTimeAsync(3000);
    expect(delivered.length).toBe(before); // no poll delivered it
    live.event(4);
    expect(delivered.at(-1)!.seq).toBe(4);
  });

  it("stop() closes the socket and silences everything", async () => {
    const { client, sockets, delivered } = setup([e(1)]);
    client.start();
    await flush();
    client.stop();
    expect(sockets[0]!.closed).toBe(true);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "event", event: e(9) }) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delivered.map((d) => d.seq)).toEqual([1]);
  });

  it("survives a failing feed endpoint", async () => {
    const { client, sockets, delivered } = setup([], {
      fetchFeed: async () => {
        throw new Error("boom");
      },
    });
    client.start();
    await flush();
    sockets[0]!.hello(0);
    sockets[0]!.event(1);
    await flush();
    expect(delivered.map((d) => d.seq)).toEqual([1]);
  });
});
