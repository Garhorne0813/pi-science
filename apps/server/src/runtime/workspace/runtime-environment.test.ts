import { describe, expect, it } from "vitest";
import { sanitizeRuntimeEnvironment } from "./runtime-environment.js";

describe("sanitizeRuntimeEnvironment", () => {
  it("removes inherited Python, Conda, and Mamba state case-insensitively", () => {
    const sanitized = sanitizeRuntimeEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/test",
      PYTHONHOME: "/host/python",
      pip_prefix: "/host/pip",
      Pi_Science_Python_Executable: "/host/python3",
      CONDA_PREFIX: "/host/conda",
      CONDA_PREFIX_2: "/host/conda-2",
      MAMBA_NO_RC: "false",
    });

    expect(sanitized).toEqual({ PATH: "/usr/bin", HOME: "/home/test" });
  });
});
