import { describe, expect, it } from "vitest";
import { buildUrl, liveUrl } from "./api.ts";

describe("urls", () => {
  it("builds queries and skips empty values", () => {
    expect(buildUrl("/feed", { after: 5, goalId: undefined, limit: 0, x: "" })).toBe("/api/feed?after=5&limit=0");
    expect(buildUrl("/goals")).toBe("/api/goals");
  });
  it("derives the websocket url from the page origin", () => {
    expect(liveUrl(undefined, "/api", { protocol: "https:", host: "idlehands.paulashraf.com" })).toBe("wss://idlehands.paulashraf.com/api/live");
    expect(liveUrl("tsp-200", "/api", { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/api/live?goalId=tsp-200");
    expect(liveUrl(undefined, "http://localhost:8787/api", { protocol: "https:", host: "x" })).toBe("ws://localhost:8787/api/live");
  });
});
