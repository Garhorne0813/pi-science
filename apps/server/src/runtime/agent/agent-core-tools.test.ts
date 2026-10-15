import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core/node";
import { todoHarnessTool } from "./worker/todo-tool.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import { CoreReviewSubagentRunner } from "../../project-review/core-subagent-runner.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { readFile } from "node:fs/promises";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-tools-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi-science"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, ".test-settings"));
  return cwd;
}

async function modelFixture(answer: (body: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }, index: number) => string | { name: string; args: unknown } | null) {
  const cwd = await workspace();
  let count = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = answer(JSON.parse(Buffer.concat(chunks).toString()), ++count);
    if (value === null) return;
    const tool = typeof value !== "string";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "local", object: "chat.completion.chunk", created: 1, model: "lab" };
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${count}`, type: "function", function: { name: value.name, arguments: JSON.stringify(value.args) } }] } : { role: "assistant", content: value };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const resources = new ModelResourceService();
  const provider = await resources.createProvider({ name: "Local", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
  const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "local-only" });
  const endpoint = await resources.createEndpoint({ name: "Local", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "local" });
  await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
  await resources.updateModel(provider.id, "lab", { enabled: true, capabilities: { reasoning: false, context_window: 128000 } });
  const { configPath, writeJsonAtomic } = await import("../../storage/persistence.js");
  const settingsPath = configPath("config.json");
  const { readJson } = await import("../../storage/persistence.js");
  await writeJsonAtomic(settingsPath, { ...await readJson(settingsPath, {}), model: `${provider.id}/lab`, thinking: "off" });
  return { cwd, model: { provider: provider.id, modelId: "lab" }, requests: () => count };
}

describe("agent-core product tools", () => {
  it("serializes todo calls, replays once, restores history and respects an older branch", async () => {
    const cwd = await workspace();
    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, ".pi-science", "agent-sessions") });
    cleanup.push(async () => { await repo.close(BACKGROUND_CONTEXT); await env.cleanup(BACKGROUND_CONTEXT); });
    let session = await repo.create({ cwd }, BACKGROUND_CONTEXT);
    let tool = todoHarnessTool(session);
    const invoke = (id: string, action: string, values: Record<string, unknown> = {}, operationId = "op-1") => tool.execute(id, { action, ...values }, () => {}, { env },
      { invocationId: id, operationId, turnId: operationId, getMemo: async () => undefined, setMemo: async () => {} } satisfies AgentHarnessToolInvocation, BACKGROUND_CONTEXT);
    const [first, second] = await Promise.all([invoke("a", "create", { subject: "first" }), invoke("b", "create", { subject: "second" })]);
    expect((second.details as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(await invoke("a", "create", { subject: "first" })).toEqual(first);
    const branch = await session.createBranch("main", null, BACKGROUND_CONTEXT);
    const firstId = await branch.appendMessage({ role: "toolResult", toolCallId: "a", toolName: "todo", ...first, details: JSON.parse(JSON.stringify(first.details)), isError: false, timestamp: 1 }, BACKGROUND_CONTEXT);
    await branch.appendMessage({ role: "toolResult", toolCallId: "b", toolName: "todo", ...second, details: JSON.parse(JSON.stringify(second.details)), isError: false, timestamp: 2 }, BACKGROUND_CONTEXT);
    const metadata = session.metadata;
    await session.close(BACKGROUND_CONTEXT);
    session = await repo.open(metadata, BACKGROUND_CONTEXT); tool = todoHarnessTool(session);
    expect(await invoke("list", "list", {}, "op-2")).toMatchObject({ details: { nextId: 3, tasks: [{ subject: "first" }, { subject: "second" }] } });
    await session.createBranch("past", firstId, BACKGROUND_CONTEXT);
    tool = todoHarnessTool(session, "past");
    expect(await invoke("past", "list", {}, "op-3")).toMatchObject({ details: { nextId: 2, tasks: [{ subject: "first" }] } });
    expect((await new AgentSessionRepository().messages(cwd, metadata.id)).at(-1)).toMatchObject({ details: { nextId: 3 } });
    await session.close(BACKGROUND_CONTEXT);
  });

  it("delegates over IPC to a hidden child and reuses its durable result after reopen", async () => {
    const fixture = await modelFixture((body, index) => index === 1 ? { name: "subagent", args: { agent: "planner", task: "Inspect evidence" } } : body.messages.some((item) => item.role === "tool") ? "Parent synthesis" : "Child evidence");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const options = { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science", "agent-sessions"), model: fixture.model, thinking: "off" as const };
    const parent = await openHiddenTask(manager, "parent-task", options, "test-owner");
    expect(await runHiddenPrompt(parent, "Delegate", "delegate-once", Date.now() + 10000)).toBe("Parent synthesis");
    expect(fixture.requests()).toBe(3);
    expect(await new AgentSessionRepository().list(fixture.cwd)).toEqual([]);
    const history = await new AgentSessionRepository().messages(fixture.cwd, parent.sessionId);
    expect(history.find((item) => item.toolName === "subagent")).toMatchObject({ details: { mode: "single", results: [{ agent: "planner", exitCode: 0, output: "Child evidence", childSessionId: expect.any(String) }] } });
    await manager.stop("parent-task");
    const reopened = await openHiddenTask(manager, "parent-task", options, "test-owner");
    expect(reopened.sessionId).toBe(parent.sessionId);
    expect(await runHiddenPrompt(reopened, "Delegate", "delegate-once", Date.now() + 10000)).toBe("Parent synthesis");
    expect(fixture.requests()).toBe(3);
  }, 20000);

  it("runs literature research with parallel skill-local roles under the parent's permissions", async () => {
    const observed: Array<{ system: string; tools: unknown[] }> = [];
    const fixture = await modelFixture((body) => {
      const system = body.messages[0]!.content; observed.push({ system, tools: body.tools ?? [] });
      if (system.includes("You are a research subagent")) return JSON.stringify({ sub_question: "Source coverage", findings: [{ claim: "Evidence is preliminary", source_refs: ["source-001"], confidence: "low" }], conflicts: [], gaps: ["independent replication"], next_steps: [] });
      if (system.includes("You are an independent reviewer")) return JSON.stringify({ status: "PARTIAL", checks: { evidence: "PARTIAL" }, blocking_issues: ["Independent replication missing"], recommendation: "revise" });
      const completed = body.messages.filter((item) => item.role === "tool").length;
      if (completed === 0) return { name: "execution_budget", args: { max_seconds: 30, max_executions: 3 } };
      if (completed === 1) return { name: "subagent", args: { tasks: [
        { agent: "auto-research/researcher", task: "Analyze coverage. Supplied source-001: one preliminary observational study; no independent replication. Protocol: verify coverage and source independence." },
        { agent: "auto-research/researcher", task: "Analyze counterevidence. Supplied source-001: one preliminary observational study; no independent replication. Protocol: identify gaps." },
      ] } };
      if (completed === 2) return { name: "subagent", args: { agent: "auto-research/reviewer", task: "Review the literature protocol and supplied findings; source-001 has no independent replication. Success requires independent evidence." } };
      return "Partial literature report: source-001 is preliminary. Independent replication remains a blocker.";
    });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "literature-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "subagent", "execution_budget"] }, "literature-owner");
    expect(await runHiddenPrompt(parent, "/skill:auto-research Investigate the supplied literature", "literature-once", Date.now() + 20000)).toContain("replication remains a blocker");
    const messages = await new AgentSessionRepository().messages(fixture.cwd, parent.sessionId);
    expect(messages.filter((item) => item.toolName === "subagent"), JSON.stringify(messages.filter((item) => item.toolName === "subagent").map((item) => item.details))).toMatchObject([
      { details: { mode: "parallel", results: [{ agent: "auto-research/researcher", exitCode: 0 }, { agent: "auto-research/researcher", exitCode: 0 }] } },
      { details: { results: [{ agent: "auto-research/reviewer", output: expect.stringContaining("PARTIAL") }] } },
    ]);
    const children = observed.filter((item) => item.system.includes("subagent") || item.system.includes("independent reviewer"));
    expect(children).toHaveLength(3);
    for (const child of children) expect(child.tools.map((tool) => (tool as { function: { name: string } }).function.name)).toEqual(["read"]);
  }, 30000);

  it("rejects skill-local delegation after the parent disables the skill without opening a child", async () => {
    const fixture = await modelFixture((body) => body.messages.some((item) => item.role === "tool")
      ? "Delegation denied by current skill policy" : { name: "subagent", args: { agent: "auto-research/reviewer", task: "Review evidence" } });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "policy-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "subagent"] }, "policy-owner");
    expect(await parent.setSkillPolicy({ mode: "none" })).toMatchObject({ success: true });
    expect(await runHiddenPrompt(parent, "Try to delegate", "disabled-local", Date.now() + 10000)).toContain("denied");
    expect(fixture.requests()).toBe(2); expect(manager.processCount).toBe(1);
    const history = await new AgentSessionRepository().messages(fixture.cwd, parent.sessionId);
    expect(history.find((item) => item.toolName === "subagent")).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("disabled") }] });
  }, 20000);

  it("executes a task-specific numerical evaluator, preserves results on resume and reports validity blockers separately", async () => {
    const evaluator = `const fs = require('node:fs'); const assert = require('node:assert/strict');
const rmse = (values, truth) => Math.sqrt(values.reduce((sum, x, i) => sum + (x - truth[i]) ** 2, 0) / truth.length);
assert.equal(rmse([1, 3], [1, 3]), 0); assert.equal(rmse([2, 4], [1, 3]), 1);
const baseline = {metric: 'rmse', value: rmse([2, 4], [1, 3]), evaluator_version: 1};
const result = {metric: 'rmse', value: rmse([1, 3], [1, 3]), evaluator_version: 1};
fs.writeFileSync('research/quant/baseline.json', JSON.stringify(baseline));
fs.writeFileSync('research/quant/result.json', JSON.stringify(result)); console.log(JSON.stringify({baseline, result}));`;
    const fixture = await modelFixture((body) => {
      if (body.messages[0]!.content.includes("You are an independent reviewer")) return '{"status":"FAIL","blocking_issues":["Final-test data was used for tuning"],"recommendation":"revise"}';
      const latestUser = body.messages.filter((item) => item.role === "user").at(-1)?.content ?? "";
      if (latestUser.includes("Resume saved quantitative")) {
        const last = body.messages.at(-1);
        return last?.role === "tool" ? "Reused completed experiment 001; no repeated computation. Validity blocker remains." : { name: "read", args: { path: "research/quant/state.json" } };
      }
      const completed = body.messages.filter((item) => item.role === "tool").length;
      if (completed === 0) return { name: "execution_budget", args: { max_seconds: 30, max_executions: 5 } };
      if (completed === 1) return { name: "write", args: { path: "research/quant/evaluation.yaml", content: "version: 1\nobjective: Reduce RMSE\nmetric: rmse\ndirection: minimize\nconstraints: [no_data_leakage]\nbudget: {max_seconds: 30, max_execution_calls: 5, max_experiments: 1}\n" } };
      if (completed === 2) return { name: "write", args: { path: "research/quant/evaluator.cjs", content: evaluator } };
      if (completed === 3) return { name: "bash", args: { command: "node research/quant/evaluator.cjs", timeout: 10 } };
      if (completed === 4) return { name: "write", args: { path: "research/quant/state.json", content: JSON.stringify({ protocol_version: 1, completed_experiments: ["001"], result_path: "research/quant/result.json", remaining_experiments: 0, blockers: ["test leakage"] }) } };
      if (completed === 5) return { name: "subagent", args: { agent: "auto-research/reviewer", task: "Review evaluation.yaml, evaluator.cjs and result.json in research/quant. Candidate metric improved; final-test data was used for tuning. Independently assess no_data_leakage." } };
      return "RMSE improved from 1 to 0, but Reviewer FAIL: final-test leakage blocks a success claim.";
    });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const options = { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off" as const };
    const parent = await openHiddenTask(manager, "quant-parent", options, "quant-owner");
    const result = await runHiddenPrompt(parent, "/skill:auto-research Compare numerical predictions", "quant-once", Date.now() + 20000);
    expect(result).toContain("leakage blocks a success claim");
    expect(JSON.parse(await readFile(join(fixture.cwd, "research/quant/baseline.json"), "utf8"))).toMatchObject({ value: 1, evaluator_version: 1 });
    expect(JSON.parse(await readFile(join(fixture.cwd, "research/quant/result.json"), "utf8"))).toMatchObject({ value: 0, evaluator_version: 1 });
    const originalRequests = fixture.requests(); await manager.stop("quant-parent");
    const reopened = await openHiddenTask(manager, "quant-parent", options, "quant-owner");
    expect(await runHiddenPrompt(reopened, "/skill:auto-research Compare numerical predictions", "quant-once", Date.now() + 10000)).toBe(result);
    expect(fixture.requests()).toBe(originalRequests);
    expect(await runHiddenPrompt(reopened, "/skill:auto-research Resume saved quantitative research", "quant-resume", Date.now() + 10000)).toContain("no repeated computation");
    const history = await new AgentSessionRepository().messages(fixture.cwd, reopened.sessionId);
    expect(history.filter((item) => item.toolName === "bash")).toHaveLength(1);
    expect(history.some((item) => item.toolName === "subagent" && JSON.stringify(item.details).includes("Final-test"))).toBe(true);
  }, 30000);

  it("runs Core project review schema repair in an independent Worker", async () => {
    const fixture = await modelFixture((body) => body.messages[0]!.content.includes("project reviewer")
      ? body.messages.length > 2 ? "[]" : "invalid-json"
      : '{"kind":"analysis","findings":[{"summary":"Measured improvement"}],"next_strategy":"Repeat"}');
    const environment = { environment: async () => ({}) };
    const review = new CoreReviewSubagentRunner(environment); cleanup.push(() => review.shutdown());
    expect(await review.run({ run_id: "review-test", cwd: fixture.cwd, session_id: "conversation", excerpt: { session_id: "conversation", messages: [], truncated: false } })).toEqual({ run_id: "review-test", output: { proposals: [] } });
    expect(await new AgentSessionRepository().list(fixture.cwd)).toEqual([]);
  }, 20000);

  it("cancels an active child when its parent operation is aborted", async () => {
    const fixture = await modelFixture((_body, index) => index === 1 ? { name: "subagent", args: { agent: "planner", task: "Wait for evidence" } } : null);
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "cancel-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science", "agent-sessions"), model: fixture.model, thinking: "off" }, "owner");
    const result = runHiddenPrompt(parent, "Delegate and wait", "cancel-once", Date.now() + 10000);
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(fixture.requests()).toBe(2), { timeout: 5000 });
    expect(manager.processCount).toBe(2);
    expect(await parent.sendCommand("abort")).toMatchObject({ success: true });
    await expect(result).rejects.toThrow("aborted");
    await vi.waitFor(() => expect(manager.processCount).toBe(1), { timeout: 5000 });
  }, 20000);

  it("waits for host-side child result persistence before shutdown completes", async () => {
    const fixture = await modelFixture((_body, index) => index === 1
      ? { name: "subagent", args: { agent: "planner", task: "Inspect evidence" } } : "Child evidence");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const persistence = await import("../../storage/persistence.js");
    const write = persistence.writeJsonAtomic;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const spy = vi.spyOn(persistence, "writeJsonAtomic").mockImplementation(async (path, value) => {
      if (path.includes("agent-task-results")) { entered = true; await blocked; }
      await write(path, value);
    });
    let shutdown: Promise<void> | undefined;
    try {
      const parent = await openHiddenTask(manager, "drain-parent", { cwd: fixture.cwd,
        sessionsRoot: join(fixture.cwd, ".pi-science", "agent-sessions"), model: fixture.model, thinking: "off" }, "owner");
      const result = runHiddenPrompt(parent, "Delegate", "drain-once", Date.now() + 30000);
      void result.catch(() => undefined);
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 15000 });
      expect(await parent.sendCommand("abort")).toMatchObject({ success: true });
      await expect(result).rejects.toThrow("aborted");
      let stopped = false;
      shutdown = manager.shutdownAll().then(() => { stopped = true; });
      await vi.waitFor(() => expect(parent.isClosed).toBe(true), { timeout: 15000 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      await shutdown;
      expect(stopped).toBe(true);
      expect(manager.processCount).toBe(0);
    } finally {
      release();
      await shutdown;
      spy.mockRestore();
    }
  }, 45000);

  it("lists and invokes skills/templates under the current resource policy", async () => {
    const requests: string[] = [];
    const fixture = await modelFixture((body) => { requests.push(JSON.stringify(body.messages)); return "Resource applied"; });
    await mkdir(join(fixture.cwd, ".pi", "skills", "inspect"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi", "skills", "inspect", "SKILL.md"), "---\nname: inspect\ndescription: Inspect evidence\n---\nFollow the evidence protocol.");
    await mkdir(join(fixture.cwd, ".pi", "prompts"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi", "prompts", "compare.md"), "---\ndescription: Compare experiments\n---\nCompare $1 against $2.");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const runtime = await openHiddenTask(manager, "resources", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science", "agent-sessions"), model: fixture.model, thinking: "off" }, "owner");
    expect(await runtime.sendCommand("get_commands")).toMatchObject({ data: { commands: expect.arrayContaining([{ name: "skill:inspect", description: "Inspect evidence", source: "skill", group: "skill" }, { name: "compare", description: "Compare experiments", source: "prompt", group: "utility" }]) } });
    expect(await runHiddenPrompt(runtime, "/compare 'trial one' control", "template-once", Date.now() + 10000)).toBe("Resource applied");
    expect(requests[0]).toContain("Compare trial one against control.");
    expect(await runHiddenPrompt(runtime, "/skill:inspect validate results", "skill-once", Date.now() + 10000)).toBe("Resource applied");
    expect(requests[1]).toContain("Follow the evidence protocol.");
    expect(await runtime.setSkillPolicy({ mode: "none" })).toMatchObject({ success: true });
    expect(await runtime.sendCommand("get_commands")).toMatchObject({ data: { commands: [{ name: "compare" }] } });
    expect(await runtime.sendCommand("prompt", { message: "/skill:inspect forbidden" })).toMatchObject({ success: false, code: "unknown_skill" });
  }, 20000);

  it("rejects a damaged v3 import before ownership and preserves a tool snapshot in a valid copy", async () => {
    const cwd = await workspace();
    const core = new AgentCoreSessionService(new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] }), { environment: async () => ({}) });
    cleanup.push(() => core.shutdownAll());
    const id = "legacy-tools";
    const rows = [
      { type: "session", version: 3, id, cwd, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Plan", timestamp: 1 } },
      { type: "message", id: "t1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolName: "todo", toolCallId: "todo1", content: [{ type: "text", text: "Created" }], details: { tasks: [{ id: 1, subject: "Inspect", status: "pending" }], nextId: 2 }, isError: false, timestamp: 2 } },
      { type: "compaction", id: "c1", parentId: "t1", timestamp: "2026-01-01T00:00:03.000Z", summary: "We planned an inspection.", firstKeptEntryId: "t1", tokensBefore: 100 },
      { type: "message", id: "branch1", parentId: "u1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: "Alternative", timestamp: 4 } },
    ];
    const original = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const source = join(cwd, "legacy.jsonl");
    await writeFile(source, original + "{damaged\n");
    const config = { model: "openai/gpt-4.1-mini", skills: [], extensions: [] };
    expect(await core.importLegacy(cwd, id, source, config)).toMatchObject({ success: false, code: "legacy_import_failed" });
    expect(await new AgentSessionRegistry().get(cwd, id)).toBeUndefined();
    await writeFile(source, original);
    expect(await core.importLegacy(cwd, id, source, config)).toMatchObject({ success: true });
    expect(await readFile(source, "utf8")).toBe(original);
    const history = await new AgentSessionRepository().messages(cwd, id);
    expect(history.find((item) => item.toolName === "todo")).toMatchObject({ details: { nextId: 2, tasks: [{ subject: "Inspect" }] } });
    expect(history.some((item) => item.content.some((part) => part.text === "Alternative"))).toBe(true);
  }, 20000);
});
