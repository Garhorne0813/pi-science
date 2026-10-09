import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { AgentRuntimeCapacityError } from "./agent-runtime-errors.js";

const roots: string[] = [];
const managers: AgentRuntimeManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdownAll()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("AgentRuntimeManager", () => {
  it("shares capacity and excludes duplicate owners across managers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-agent-capacity-")); roots.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    const first = new AgentRuntimeManager(), second = new AgentRuntimeManager(); managers.push(first, second);
    const options = { cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"), model: { provider: "openai", modelId: "gpt-4.1-mini" } };
    vi.stubEnv("PI_SCIENCE_AGENT_MAX_WORKERS", "1");
    const runtime = await first.start("first", options);
    // Typed, so the caller can record a definite rejection instead of an
    // ambiguous one and let the same prompt ID retry.
    await expect(second.start("extra", options)).rejects.toThrow(AgentRuntimeCapacityError);
    vi.stubEnv("PI_SCIENCE_AGENT_MAX_WORKERS", "2");
    await expect(second.start("duplicate", { ...options, sessionId: runtime.sessionId })).rejects.toThrow("another manager");
    await first.stop("first");
    const reopened = await second.start("reopened", { ...options, sessionId: runtime.sessionId });
    expect(reopened.sessionId).toBe(runtime.sessionId);
  }, 20000);
  it("deduplicates opens of the same session and clears ownership on exit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-agent-manager-"));
    roots.push(cwd);
    const sessionsRoot = join(cwd, ".pi-science", "agent-sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const manager = new AgentRuntimeManager();
    managers.push(manager);
    const options = { cwd, sessionsRoot, model: { provider: "openai", modelId: "gpt-4.1-mini" } };
    const first = await manager.start("create", options);
    const duplicate = await manager.start("same-session", { ...options, sessionId: first.sessionId });
    expect(duplicate).toBe(first);
    expect(manager.processCount).toBe(1);
    await manager.stop("create");
    expect(manager.processCount).toBe(0);
  });
});
