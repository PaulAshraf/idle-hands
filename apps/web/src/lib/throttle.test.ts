import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttle } from "./throttle.ts";

describe("throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("runs first call now and collapses a burst into one trailing run", () => {
    const fn = vi.fn();
    const t = throttle(fn, 1000);
    t.call();
    expect(fn).toHaveBeenCalledTimes(1);
    t.call();
    t.call();
    t.call();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("cancel drops the trailing run", () => {
    const fn = vi.fn();
    const t = throttle(fn, 1000);
    t.call();
    t.call();
    t.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
