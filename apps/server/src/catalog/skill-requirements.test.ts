import { describe, expect, it, vi } from "vitest";
import type { SkillRequirement } from "@pi-science/contracts";
import { probeRequirements, type RequirementProbeEnv } from "./skill-requirements.js";

function requirement(partial: Partial<SkillRequirement>): SkillRequirement {
  return { name: "dep", kind: "other", optional: false, ...partial } as SkillRequirement;
}

function probeEnv(overrides: Partial<RequirementProbeEnv> = {}): RequirementProbeEnv {
  return {
    findExecutableFn: vi.fn(async (command: string) => (command === "node" ? "/usr/bin/node" : null)),
    findPythonFn: vi.fn(async () => "/usr/bin/python3"),
    checkPythonFn: vi.fn(async () => ({ ok: true, version: "3.12.1" })),
    checkPackageFn: vi.fn(async (moduleName: string) => moduleName === "numpy"),
    ...overrides,
  };
}

describe("probeRequirements", () => {
  it("reports a present command as ready", async () => {
    const env = probeEnv();
    const result = await probeRequirements("s1", [requirement({ name: "node", kind: "command" })], env);
    expect(result).toEqual({
      skill_id: "s1",
      ready: true,
      requirements: [{ name: "node", kind: "command", optional: false, version: null, status: "ready" }],
    });
  });

  it("blocks a missing required command with reason and hint", async () => {
    const result = await probeRequirements("s1", [requirement({ name: "tectonic", kind: "command" })], probeEnv());
    expect(result.ready).toBe(false);
    expect(result.requirements[0]).toMatchObject({
      name: "tectonic",
      status: "missing",
      reason: 'Command "tectonic" not found on PATH',
      hint: "brew install tectonic / apt install tectonic",
    });
  });

  it("does not block a missing optional command", async () => {
    const result = await probeRequirements(
      "s1",
      [requirement({ name: "tectonic", kind: "command", optional: true })],
      probeEnv(),
    );
    expect(result.ready).toBe(true);
    expect(result.requirements[0]?.status).toBe("missing-optional");
  });

  it("probes python interpreter and reports its version", async () => {
    const result = await probeRequirements("s1", [requirement({ name: "python", kind: "python" })], probeEnv());
    expect(result.ready).toBe(true);
    expect(result.requirements[0]).toMatchObject({ status: "ready", version: "3.12.1" });
  });

  it("blocks when no python interpreter exists", async () => {
    const env = probeEnv({ findPythonFn: vi.fn(async () => null) });
    const result = await probeRequirements("s1", [requirement({ name: "python", kind: "python" })], env);
    expect(result.ready).toBe(false);
    expect(result.requirements[0]).toMatchObject({
      status: "missing",
      reason: "No Python interpreter found (PI_SCIENCE_PYTHON, python3, python)",
    });
  });

  it("reports an installed package as ready and a missing one as blocked", async () => {
    const env = probeEnv();
    const result = await probeRequirements(
      "s1",
      [requirement({ name: "numpy", kind: "package" }), requirement({ name: "scanpy", kind: "package" })],
      env,
    );
    expect(result.ready).toBe(false);
    expect(result.requirements.map((item) => [item.name, item.status])).toEqual([
      ["numpy", "ready"],
      ["scanpy", "missing"],
    ]);
    expect(result.requirements[1]).toMatchObject({
      reason: 'Python package "scanpy" is not installed in /usr/bin/python3',
      hint: "pip install scanpy",
    });
  });

  it("normalises dashed package names to module names", async () => {
    const checkPackageFn = vi.fn(async () => true);
    await probeRequirements("s1", [requirement({ name: "python-pptx", kind: "package" })], probeEnv({ checkPackageFn }));
    expect(checkPackageFn).toHaveBeenCalledWith("python_pptx", "/usr/bin/python3");
  });

  it("treats missing optional packages as non-blocking", async () => {
    const result = await probeRequirements(
      "s1",
      [requirement({ name: "scanpy", kind: "package", optional: true })],
      probeEnv(),
    );
    expect(result.ready).toBe(true);
    expect(result.requirements[0]?.status).toBe("missing-optional");
  });

  it("reports service and unknown kinds as not-probed without blocking", async () => {
    const result = await probeRequirements(
      "s1",
      [requirement({ name: "pubchem", kind: "service" }), requirement({ name: "thing", kind: "other" })],
      probeEnv(),
    );
    expect(result.ready).toBe(true);
    expect(result.requirements.map((item) => item.status)).toEqual(["not-probed", "not-probed"]);
  });

  it("discovers the python interpreter only once for multiple requirements", async () => {
    const findPythonFn = vi.fn(async () => "/usr/bin/python3");
    await probeRequirements(
      "s1",
      [requirement({ name: "numpy", kind: "package" }), requirement({ name: "python", kind: "python" })],
      probeEnv({ findPythonFn }),
    );
    expect(findPythonFn).toHaveBeenCalledTimes(1);
  });

  it("returns ready for an empty requirement list", async () => {
    const result = await probeRequirements("s1", [], probeEnv());
    expect(result).toEqual({ skill_id: "s1", ready: true, requirements: [] });
  });
});
