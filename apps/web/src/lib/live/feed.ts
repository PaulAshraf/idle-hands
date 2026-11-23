import type { FeedEvent } from "@idle-hands/protocol";

/**
 * Remembers which event seqs were already delivered. A reconnect backfill and the live socket can both
 * deliver the same event; `accept` is true exactly once per seq. Not a high-water mark on purpose:
 * during a backfill an event with a larger seq can arrive before smaller ones.
 */
export class SeqGate {
  private seen = new Set<number>();
  private _max = 0;
  private readonly keep: number;
  constructor(keep = 4096) {
    this.keep = keep;
  }

  /** Largest seq accepted so far (0 before any). */
  get max(): number {
    return this._max;
  }

  has(seq: number): boolean {
    return this.seen.has(seq);
  }

  accept(seq: number): boolean {
    if (this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this._max) this._max = seq;
    if (this.seen.size > this.keep * 1.5) {
      const floor = this._max - this.keep;
      for (const s of this.seen) if (s < floor) this.seen.delete(s);
    }
    return true;
  }
}

/** Merge event lists by seq: ascending, no duplicates, newest `cap` kept. Inputs are not mutated. */
export function mergeEvents(existing: readonly FeedEvent[], incoming: readonly FeedEvent[], cap = Infinity): FeedEvent[] {
  const bySeq = new Map<number, FeedEvent>();
  for (const e of existing) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
