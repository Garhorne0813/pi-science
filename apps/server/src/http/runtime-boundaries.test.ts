import { describe, expect, it } from "vitest";
import { routeBoundaries, routeBoundary, runtimeOwner } from "./runtime-boundaries.js";

describe("runtime route boundaries", () => {
  it("marks kernels and notebooks as Node-native routes", () => {
    expect(runtimeOwner("/api/kernels/execute")).toBe("node-control-plane");
    expect(runtimeOwner("/api/notebooks/jupyter/status")).toBe("node-control-plane");
    expect(runtimeOwner("/api/sessions/session-1/events")).toBe("node-control-plane");
    expect(routeBoundary("/api/response-versions")).toMatchObject({
      prefix: "/api/response-versions",
      owner: "node-control-plane",
      availability: "native",
    });
    expect(routeBoundary("/api/response-versions/version-1/message")?.prefix).toBe("/api/response-versions");
    expect(routeBoundary("/api/response-versions-extra")).toBeUndefined();
    expect(routeBoundary("/api/unknown-route")).toBeUndefined();
  });

  it("leaves no scientific-runtime compatibility proxies", () => {
    expect(routeBoundaries.filter((boundary) => boundary.availability === "compatibility-proxy")).toEqual([]);
  });
});
