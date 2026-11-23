import { describe, expect, it } from "vitest";
import { SeqGate, mergeEvents } from "./feed.ts";
import { ev, message } from "../../test-utils.ts";

const e = (seq: number) => ev(seq, "message.created", message(`msg_${seq}`));

describe("SeqGate", () => {
  it("accepts each seq once", () => {
    const g = new SeqGate();
    expect(g.accept(5)).toBe(true);
    expect(g.accept(5)).toBe(false);
    expect(g.accept(3)).toBe(true); // older seq after a newer one: still new
    expect(g.max).toBe(5);
    expect(g.has(3)).toBe(true);
  });
  it("stays bounded", () => {
    const g = new SeqGate(10);
    for (let i = 1; i <= 100; i++) g.accept(i);
    expect(g.max).toBe(100);
    expect(g.accept(100)).toBe(false);
  });
});

describe("mergeEvents", () => {
  it("merges, de-duplicates by seq and sorts ascending", () => {
    const merged = mergeEvents([e(3), e(1)], [e(2), e(3), e(4)]);
    expect(merged.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });
  it("keeps the newest `cap` events", () => {
    expect(mergeEvents([e(1), e(2), e(3)], [e(4)], 2).map((x) => x.seq)).toEqual([3, 4]);
  });
  it("does not mutate its inputs", () => {
    const a = [e(2)];
    mergeEvents(a, [e(1)]);
    expect(a).toHaveLength(1);
  });
});
