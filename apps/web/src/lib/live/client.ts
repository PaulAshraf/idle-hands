import type { FeedEvent, FeedResponse, LiveFrame } from "@idle-hands/protocol";
import { SeqGate } from "./feed.ts";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "polling";

/** The slice of WebSocket the client uses; the mock backend implements it too. */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface FeedParams {
  after?: number;
  goalId?: string;
  limit?: number;
}

export interface LiveClientOptions {
  url: string;
  goalId?: string;
  /** `replay` is true for the initial catch-up of already-old events, so the UI can skip celebrations. */
  onEvent: (event: FeedEvent, meta: { replay: boolean }) => void;
  onState?: (state: ConnectionState) => void;
  fetchFeed: (params: FeedParams) => Promise<FeedResponse>;
  createSocket?: (url: string) => SocketLike;
  pingIntervalMs?: number;
  pollIntervalMs?: number;
  /** Events fetched on the very first sync. */
  bootstrapLimit?: number;
  /** Consecutive failed connects before the client also starts polling. */
  failuresBeforePolling?: number;
  random?: () => number;
}

const FEED_PAGE = 200;

/** Exponential backoff with jitter: ~1s, 2s, 4s … capped at 30s. `attempt` starts at 1. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * One WebSocket to /api/live with everything the protocol asks of a client: backfill from /api/feed on every
 * (re)connect, de-duplication by seq, ping keepalive, reconnect with backoff, and a polling fallback when the
 * socket cannot be established.
 */
export class LiveClient {
  private readonly o: LiveClientOptions;
  private readonly gate = new SeqGate();
  private socket: SocketLike | null = null;
  private stopped = true;
  private failures = 0;
  private bootstrapped = false;
  private syncing = false;
  private syncAgain = false;
  private buffer: FeedEvent[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private _state: ConnectionState = "connecting";

  constructor(options: LiveClientOptions) {
    this.o = options;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** Largest seq delivered so far. */
  get lastSeq(): number {
    return this.gate.max;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.setState("connecting");
    void this.sync();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  }

  private setState(s: ConnectionState): void {
    if (s === this._state) return;
    this._state = s;
    this.o.onState?.(s);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.reconnectTimer = this.pingTimer = this.pollTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = (this.o.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(this.o.url);
    } catch {
      this.handleDrop();
      return;
    }
    this.socket = socket;
    this.lastMessageAt = Date.now();
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      this.handleFrame(ev.data);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.handleDrop();
    };
    socket.onerror = () => {
      /* a close always follows; handled there */
    };
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== "string" || data === "pong") return;
    let frame: LiveFrame;
    try {
      frame = JSON.parse(data) as LiveFrame;
    } catch {
      return;
    }
    if (frame.type === "hello") {
      this.failures = 0;
      this.stopPolling();
      this.setState("live");
      this.startPing();
      void this.sync();
    } else if (frame.type === "event") {
      if (this.syncing) this.buffer.push(frame.event);
      else this.deliver([frame.event], false);
    }
  }

  private handleDrop(): void {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.failures += 1;
    if (this.failures >= (this.o.failuresBeforePolling ?? 3)) {
      this.setState("polling");
      this.startPolling();
    } else {
      this.setState("reconnecting");
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoffMs(this.failures, this.o.random));
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const every = this.o.pingIntervalMs ?? 25_000;
    this.pingTimer = setInterval(() => {
      const s = this.socket;
      if (!s) return;
      // Nothing (not even a pong) for 2.5 intervals: the connection is dead without having said so.
      if (Date.now() - this.lastMessageAt > every * 2.5) {
        this.handleDrop();
        return;
      }
      try {
        s.send("ping");
      } catch {
        this.handleDrop();
      }
    }, every);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.sync(), this.o.pollIntervalMs ?? 5000);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** De-duplicate and hand events to the consumer in seq order. */
  private deliver(events: readonly FeedEvent[], replay: boolean): void {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (const e of sorted) {
      if (this.gate.accept(e.seq)) this.o.onEvent(e, { replay });
    }
  }

  /** Catch up from /api/feed. The first run loads the latest events (replay); later runs fill the gap since `lastSeq`. */
  private async sync(): Promise<void> {
    if (this.stopped) return;
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      if (!this.bootstrapped) {
        const res = await this.o.fetchFeed({ goalId: this.o.goalId, limit: this.o.bootstrapLimit ?? 50 });
        if (this.stopped) return;
        this.bootstrapped = true;
        this.deliver(res.events, true);
        // Events the socket delivered while we waited are newer than the snapshot; they follow below.
      } else {
        let after = this.gate.max;
        for (let page = 0; page < 20; page++) {
          const res = await this.o.fetchFeed({ after, goalId: this.o.goalId, limit: FEED_PAGE });
          if (this.stopped) return;
          this.deliver(res.events, false);
          const last = res.events[res.events.length - 1];
          if (res.events.length < FEED_PAGE || !last) break;
          after = last.seq;
        }
      }
    } catch {
      /* The next hello or poll tick retries. */
    } finally {
      this.syncing = false;
      if (!this.stopped) {
        const buffered = this.buffer;
        this.buffer = [];
        if (buffered.length) this.deliver(buffered, false);
        if (this.syncAgain) {
          this.syncAgain = false;
          void this.sync();
        }
      }
    }
  }
}
