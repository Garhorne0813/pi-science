import { describe, expect, it, vi } from "vitest";
import { createServerModules } from "./server-modules.js";

describe("server module graph", () => {
  it("gives every app an isolated runtime graph", () => {
    const first = createServerModules();
    const second = createServerModules();

    expect(first.sessions).not.toBe(second.sessions);
    expect(first.events).not.toBe(second.events);
    expect(first.sessionRepository).not.toBe(second.sessionRepository);
    expect(first.runtimeCatalog).not.toBe(second.runtimeCatalog);
    expect(first.settings).not.toBe(second.settings);
    expect(first.jobs).not.toBe(second.jobs);
    expect(first.executions).not.toBe(second.executions);
    expect(first.promptSubmissions).not.toBe(second.promptSubmissions);
    expect(first.sqliteEnabled).toBe(false);
    expect(second.sqliteEnabled).toBe(false);
  });
});

it("wires permission changes to independent kernel resource revocation", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pi-science-module-approval-"));
  vi.stubEnv("PI_SCIENCE_HOME", join(root, "private"));
  try {
    await mkdir(join(root, ".pi-science"));
    const modules = createServerModules();
    const { AgentSessionRepository } = await import("../runtime/agent/agent-session-repository.js");
    vi.spyOn(AgentSessionRepository.prototype, "findPath").mockResolvedValue(
      join(root, "session.jsonl"),
    );
    vi.spyOn(modules.sessionRepository, "findPath").mockResolvedValue(join(root, "session.jsonl"));
    const has = vi.spyOn(modules.kernels, "hasOwner").mockReturnValue(true);
    const revoke = vi.spyOn(modules.kernels, "revokeOwner").mockImplementation(async () => {
      has.mockReturnValue(false);
      return { kernelRestartCount: 1 };
    });
    const result = await modules.sessions.setApprovalMode("session-a", root, "auto", 0);
    expect(result).toMatchObject({
      success: true,
      data: { kernelRestartCount: 1, runtimeRestarted: false },
    });
    expect(revoke).toHaveBeenCalledWith(expect.any(String), "session-a");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the app-owned repositories for Memory validation and respects injected replacements", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "pi-science-memory-wiring-"));
  vi.stubEnv("PI_SCIENCE_HOME", join(root, "private"));
  const modules = createServerModules();
  try {
    await mkdir(join(root, ".pi-science"));
    expect(modules.memory.sessions).toBe(modules.sessionRepository);
    const sessions = vi.spyOn(modules.sessionRepository, "findPath").mockResolvedValue(null);
    await expect(modules.memory.context(root, "user", "missing")).rejects.toMatchObject({
      kind: "not_found",
    });
    sessions.mockResolvedValue(join(root, "session.jsonl"));
    const { context } = await modules.memory.context(root, "user", "session");
    const executions = vi.spyOn(modules.executions, "get").mockResolvedValue(null);
    const content = {
      scope: "project",
      kind: "observation",
      title: "Result",
      body: "A result",
      sources: [{ kind: "run", locator: "exec-1" }],
    };
    await expect(modules.memory.validateContent(root, context, content)).rejects.toThrow(
      "Execution source not found",
    );
    expect(executions).toHaveBeenCalledWith(expect.any(String), "exec-1");
  } finally {
    await modules.stateStore.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
