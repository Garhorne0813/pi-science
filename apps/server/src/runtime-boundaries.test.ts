import { describe, expect, it } from "vitest";
import { routeBoundaries, routeBoundary, runtimeOwner } from "./runtime-boundaries.js";

describe("runtime route boundaries", () => {
  it("keeps scientific routes on Python and control routes on Node", () => {
    expect(runtimeOwner("/api/kernels/execute")).toBe("python-scientific-runtime");
    expect(runtimeOwner("/api/sessions/session-1/events")).toBe("node-control-plane");
    expect(routeBoundary("/api/unknown-route")).toBeUndefined();
  });

  it("leaves only scientific runtime groups as compatibility proxies", () => {
    expect(routeBoundaries.filter((boundary) => boundary.availability === "compatibility-proxy").map((boundary) => boundary.prefix)).toEqual([
      "/api/kernels", "/api/notebooks", "/api/pdfs", "/api/figures", "/api/literature",
    ]);
  });
});
