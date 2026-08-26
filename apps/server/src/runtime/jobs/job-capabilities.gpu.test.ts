import { describe, expect, beforeEach, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync }));

import { detectJobCapabilities, resetJobCapabilityProbeCache } from "./job-capabilities.js";

describe("job GPU capability probe", () => {
  beforeEach(() => {
    resetJobCapabilityProbeCache();
    spawnSync.mockImplementation((command: string) => {
      if (command === "nvidia-smi") return { status: 0, stdout: "NVIDIA A100, 40960, 550.54\n" };
      return { status: 1, stdout: "" };
    });
  });

  it("uses nvidia-smi hardware output instead of only visibility variables", () => {
    const report = detectJobCapabilities({ gpu: true }, { platform: "linux", environment: { PATH: "" } });

    expect(report.status).toBe("ready");
    expect(report.checks.gpu_details).toEqual({
      available: true,
      source: "nvidia-smi",
      vendor: "NVIDIA",
      model: "NVIDIA A100",
      memory_mb: 40_960,
      driver: "550.54",
    });
    expect(spawnSync).toHaveBeenCalledWith(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
      expect.objectContaining({ env: { PATH: "" } }),
    );
  });
});
