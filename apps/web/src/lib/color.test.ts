import { describe, expect, it } from "vitest";
import { agentColor, agentHue, agentStyle, classColor, hashString } from "./color.ts";

describe("agent colors", () => {
  it("are deterministic", () => {
    expect(agentHue("ih_abc")).toEqual(agentHue("ih_abc"));
    expect(agentColor("ih_abc", false)).toBe(agentColor("ih_abc", false));
    expect(agentStyle("ih_abc")).toEqual(agentStyle("ih_abc"));
    expect(hashString("ih_abc")).toBe(hashString("ih_abc"));
  });
  it("stay in range", () => {
    for (let i = 0; i < 500; i++) {
      const { hue, variant } = agentHue(`ih_${i.toString(16).padStart(24, "0")}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360.1);
      expect([0, 1, 2]).toContain(variant);
    }
  });
  it("spread across the hue wheel and differ between neighbours", () => {
    const hues = new Set<number>();
    for (let i = 0; i < 200; i++) hues.add(Math.floor(agentHue(`ih_${"0".repeat(23)}${i}`).hue / 30));
    expect(hues.size).toBeGreaterThanOrEqual(10); // 12 buckets of 30°
    expect(agentColor("ih_000000000000000000000001")).not.toBe(agentColor("ih_000000000000000000000002"));
  });
  it("is lighter in dark mode", () => {
    const l = (s: string) => Number(/oklch\(([\d.]+)/.exec(s)![1]);
    expect(l(agentColor("ih_x", true))).toBeGreaterThan(l(agentColor("ih_x", false)));
  });
  it("gives distinct class colors", () => {
    expect(new Set(Array.from({ length: 30 }, (_, i) => classColor(i, 30))).size).toBe(30);
  });
});
