import { describe, expect, it } from "vitest";
import { bestBefore, compactNumber, deltaVsBest, fingerprint, formatCountdown, formatDelta, formatDuration, formatPercent, improvementPercent, isImprovement, kindLabel, plural, relativeTime, shortKey } from "./format.ts";
import { iso, point, submission, T0 } from "../test-utils.ts";

describe("relativeTime", () => {
  const now = T0;
  it("buckets", () => {
    expect(relativeTime(iso(-2), now)).toBe("just now");
    expect(relativeTime(iso(-42), now)).toBe("42s ago");
    expect(relativeTime(iso(-120), now)).toBe("2m ago");
    expect(relativeTime(iso(-3 * 3600), now)).toBe("3h ago");
    expect(relativeTime(iso(-5 * 86400), now)).toBe("5d ago");
  });
  it("handles future, null and junk", () => {
    expect(relativeTime(iso(30), now)).toBe("just now");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("nonsense", now)).toBe("unknown");
  });
});

describe("countdown and duration", () => {
  it("formats", () => {
    expect(formatCountdown(0)).toBe("expired");
    expect(formatCountdown(-5)).toBe("expired");
    expect(formatCountdown(12 * 60_000 + 4_000)).toBe("12:04");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(65 * 60_000)).toBe("1h 05m");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(8 * 3600_000 + 56 * 60_000)).toBe("8h 56m");
    expect(formatDuration(3 * 86400_000)).toBe("3d");
  });
});

describe("misc formatting", () => {
  it("formats numbers and labels", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(12_345)).toBe("12.3K");
    expect(plural(1, "agent")).toBe("1 agent");
    expect(plural(2, "agent")).toBe("2 agents");
    expect(kindLabel("claude-code")).toBe("Claude Code");
    expect(kindLabel("weird-kind")).toBe("weird-kind");
    expect(formatPercent(0.314)).toBe("0.31%");
    expect(formatPercent(18.3)).toBe("18%");
  });
  it("shortens keys", () => {
    expect(shortKey("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")).toBe("abcdefgh…DEFG");
    expect(shortKey("short")).toBe("short");
    expect(fingerprint("ih_0123456789abcdef01234567")).toBe("0123 4567 89ab cdef");
  });
  it("formats deltas with the verifier's decimals", () => {
    expect(formatDelta("tsp", -12.4)).toBe("−12.40");
    expect(formatDelta("graph-coloring", 3)).toBe("+3");
    expect(formatDelta("tsp", 0)).toBe("±0");
    expect(isImprovement("minimize", -1)).toBe(true);
    expect(isImprovement("maximize", -1)).toBe(false);
  });
});

describe("delta vs the best at the time", () => {
  const history = [point("s1", 100, 0), point("s2", 90, 60), point("s3", 80, 120)];
  it("uses the last improvement strictly before the submission", () => {
    expect(bestBefore(submission("x", { createdAt: iso(90) }), history)).toBe(90);
    expect(bestBefore(submission("x", { createdAt: iso(-5) }), history)).toBeNull();
  });
  it("never uses the submission's own improvement as its baseline", () => {
    expect(bestBefore(submission("s2", { createdAt: iso(60) }), history)).toBe(100);
  });
  it("computes accepted deltas and skips rejected ones", () => {
    expect(deltaVsBest(submission("x", { createdAt: iso(90), score: 95 }), history)).toBe(5);
    expect(deltaVsBest(submission("x", { status: "rejected", score: null, error: "bad" }), history)).toBeNull();
    expect(deltaVsBest(submission("x", { createdAt: iso(-5), score: 95 }), history)).toBeNull();
  });
});

describe("improvementPercent", () => {
  it("measures progress in the objective's direction", () => {
    const h = [point("a", 200, 0), point("b", 150, 10)];
    expect(improvementPercent("minimize", h)).toBe(25);
    expect(improvementPercent("maximize", [point("a", 100, 0), point("b", 150, 10)])).toBe(50);
    expect(improvementPercent("minimize", [])).toBeNull();
  });
});
