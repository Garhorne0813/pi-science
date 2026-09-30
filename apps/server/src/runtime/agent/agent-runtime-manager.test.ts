import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";

const roots: string[] = [];
const managers: AgentRuntimeManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdownAll()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentRuntimeManager", () => {
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
