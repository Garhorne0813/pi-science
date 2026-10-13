import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("kernel isolation configuration", () => {
  it("defaults to workspace, accepts explicit policies and rejects unknown policies", () => {
    expect(loadConfig({}).kernelIsolation).toBe("workspace");
    for (const policy of ["workspace", "workspace-network", "unconfined"]) expect(loadConfig({ PI_SCIENCE_KERNEL_ISOLATION: policy }).kernelIsolation).toBe(policy);
    expect(() => loadConfig({ PI_SCIENCE_KERNEL_ISOLATION: "unknown" })).toThrow();
  });
});
