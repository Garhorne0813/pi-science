import { describe, expect, it } from "vitest";
import { detectJobCapabilities } from "./job-capabilities.js";

describe("job capability detection", () => {
  it("reports the selected environment revision and matches package specs", () => {
    const report = detectJobCapabilities(
      { packages: ["numpy>=2", "conda-forge::scipy"] },
      {
        environment: { PATH: "" },
        environment_revision_id: "rev_science_2",
        environment_ready: true,
        environment_prefix: "/workspace/.envs/science",
        environment_packages: ["python=3.12", "numpy", "scipy=1.15"],
        cpu: 8,
        memory_mb: 16_384,
        gpu: { available: true, source: "nvidia-smi", vendor: "NVIDIA", model: "A100", memory_mb: 40_960 },
      },
    );

    expect(report.status).toBe("ready");
    expect(report.checks.environment).toEqual({
      revision_id: "rev_science_2",
      ready: true,
      prefix: "/workspace/.envs/science",
      packages: ["python=3.12", "numpy", "scipy=1.15"],
    });
    expect(report.checks.packages).toEqual({ "numpy>=2": true, "conda-forge::scipy": true });
    expect(report.checks.gpu).toBe(true);
    expect(report.checks.gpu_details.model).toBe("A100");
  });

  it("blocks missing packages, unavailable revisions, and requested GPUs", () => {
    const report = detectJobCapabilities(
      { packages: ["pandas", "missing"], environment_revision_id: "rev_requested", gpu: true },
      {
        environment: { PATH: "" },
        environment_revision_id: "rev_bound",
        environment_ready: false,
        environment_packages: ["python=3.12", "pandas"],
        cpu: 4,
        memory_mb: 4_096,
        gpu: { available: false, source: "none" },
      },
    );

    expect(report.status).toBe("blocked");
    expect(report.checks.packages).toEqual({ pandas: true, missing: false });
    expect(report.reasons).toEqual(expect.arrayContaining([
      "GPU requested but no GPU was detected",
      "requires environment revision rev_requested, workspace has rev_bound",
      "environment revision rev_bound is not ready",
      "package not available: missing",
    ]));
  });
});
