/** Installs the mock backend in the browser: patches `fetch` for /api and replaces `WebSocket` for /api/live. */
import type { FeedEvent, LiveFrame } from "@idle-hands/protocol";
import { MockWorld } from "./world.ts";

interface MockHandle {
  world: MockWorld;
  /** Close every open live socket from the "server" side (exercises reconnect + backfill). */
  dropSockets: () => void;
  /** While true, new socket connections fail (exercises the polling fallback). */
  failSockets: (fail: boolean) => void;
}

class MockSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readyState = 0;
  private unsub: (() => void) | null = null;

  private readonly world: MockWorld;
  private readonly registry: Set<MockSocket>;
  private readonly failing: () => boolean;

  constructor(url: string, world: MockWorld, registry: Set<MockSocket>, failing: () => boolean) {
    this.world = world;
    this.registry = registry;
    this.failing = failing;
    const goalId = new URL(url, location.href).searchParams.get("goalId");
    setTimeout(() => {
      if (this.failing()) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.readyState = 1;
      this.registry.add(this);
      this.onopen?.({});
      this.send_({ type: "hello", latestSeq: this.world.latestSeq, serverTime: new Date().toISOString() });
      this.unsub = this.world.subscribe((event: FeedEvent) => {
        if (!goalId || event.goalId === goalId) this.send_({ type: "event", event });
      });
    }, 150);
  }

  private send_(frame: LiveFrame): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string): void {
    if (data === "ping" && this.readyState === 1) setTimeout(() => this.onmessage?.({ data: "pong" }), 20);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.unsub?.();
    this.registry.delete(this);
    this.onclose?.({});
  }
}

export function installMock(): MockHandle {
  const world = new MockWorld();
  world.start();
  const sockets = new Set<MockSocket>();
  let failing = false;

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 90));
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { status, body } = world.handle(url.pathname, url.searchParams);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };

  window.WebSocket = class extends MockSocket {
    constructor(url: string | URL) {
      super(String(url), world, sockets, () => failing);
    }
  } as unknown as typeof WebSocket;

  const handle: MockHandle = {
    world,
    dropSockets: () => [...sockets].forEach((s) => s.close()),
    failSockets: (fail) => {
      failing = fail;
      if (fail) handle.dropSockets();
    },
  };
  (window as unknown as { __idleHandsMock: MockHandle }).__idleHandsMock = handle;
  console.info("[idle-hands] mock backend active: simulated agents, real verifiers. window.__idleHandsMock has dropSockets() / failSockets().");
  return handle;
}
