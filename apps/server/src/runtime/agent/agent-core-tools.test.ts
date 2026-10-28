import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core/node";
import { todoHarnessTool } from "./worker/todo-tool.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import { ModelConfigService } from "../../model-config/model-config-service.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import { CoreReviewSubagentRunner } from "../../project-review/core-subagent-runner.js";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { readFile } from "node:fs/promises";

const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-tools-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi-science"));
  const settings = await mkdtemp(join(tmpdir(), "pi-science-core-settings-"));
  cleanup.push(() => rm(settings, { recursive: true, force: true }));
  vi.stubEnv("PI_SCIENCE_HOME", settings);
  return cwd;
}

type ModelAnswer = string | { name: string; args: unknown } | null;
async function modelFixture(answer: (body: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }, index: number) => ModelAnswer | Promise<ModelAnswer>) {
  const cwd = await workspace();
  let count = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = await answer(JSON.parse(Buffer.concat(chunks).toString()), ++count);
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
  const provider = { id: "native-lab" };
  await new ModelConfigService().createProvider(0, provider.id, { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "lab", reasoning: false, contextWindow: 128000 }] }, { source: "managed", secret: "local-only" });
  const { configPath, writeJsonAtomic } = await import("../../storage/persistence.js");
  const settingsPath = configPath("config.json");
  const { readJson } = await import("../../storage/persistence.js");
  await writeJsonAtomic(settingsPath, { ...await readJson(settingsPath, {}), model: `${provider.id}/lab`, thinking: "off" });
  return { cwd, model: { provider: provider.id, modelId: "lab" }, requests: () => count };
}

describe("agent-core product tools", () => {
  it.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["linux", "darwin"].includes(process.platform))("appends Skill-owned decisions and rebuilds the index through real sandboxed Parent Bash", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    vi.stubEnv("PI_SCIENCE_SANDBOX_RUNTIME_PATHS", JSON.stringify([process.execPath]));
    const { shellQuote } = await import("../sandbox/process.js");
    const fixture = await modelFixture((body) => {
      if (!body.messages.some((message) => message.role === "tool")) return { name: "bash", args: { command: `${shellQuote(process.execPath)} helpers/research-journal.mjs append study event.json && ${shellQuote(process.execPath)} helpers/research-journal.mjs rebuild study` } };
      expect(body.messages.at(-1)!.content).toContain('"event_count":1');
      return "Research decision committed and index rebuilt.";
    });
    await mkdir(join(fixture.cwd, "helpers")); await mkdir(join(fixture.cwd, "study"));
    for (const name of ["research-journal.mjs", "validate-manifest.mjs"]) await writeFile(join(fixture.cwd, "helpers", name), await readFile(new URL(`../../../../../skills/auto-research/scripts/${name}`, import.meta.url), "utf8"));
    await writeFile(join(fixture.cwd, "event.json"), JSON.stringify({ schema_version: 1, event_id: "created-one", research_id: "study", type: "candidate_created", payload: { candidate_id: "one", hypothesis: "A bounded hypothesis" } }));
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "journal-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["bash"], skillPolicy: { mode: "none" } }, "journal-owner");
    expect(await runHiddenPrompt(parent, "Append research decisions", "journal-once", Date.now() + 30_000)).toBe("Research decision committed and index rebuilt.");
    const manifest = JSON.parse(await readFile(join(fixture.cwd, "study/manifest.json"), "utf8"));
    expect(manifest.candidates.one).toEqual({ path: "candidates/one", hypothesis: "A bounded hypothesis" });
    expect((await readFile(join(fixture.cwd, "study/research-events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  }, 45_000);

  it.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["linux", "darwin"].includes(process.platform)).each([false, true])("keeps a mixed generic grant isolated with a legacy research binding=%s and sandbox_run excluded", async (legacyBinding) => {
    const fixture = await modelFixture((body) => {
      const results = body.messages.filter((message) => message.role === "tool");
      if (body.messages[0]!.content.includes("You are a draft maker")) {
        expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(["read", "bash"]);
        if (!results.length) return { name: "read", args: { path: "drafts/one/input/approved.txt" } };
        if (results.length === 1) { expect(results[0]!.content).toContain("approved"); return { name: "bash", args: { command: "cat ../input/approved.txt > output.txt; test ! -r ../../../evaluator/private.txt; test ! -r ../../../.pi-science/protected; ! (printf tamper > ../../../research-events.jsonl); echo draft-isolated" } }; }
        expect(results.at(-1)!.content).toContain("draft-isolated");
        return "Draft created with real isolated execution.";
      }
      if (legacyBinding && !results.length) return { name: "execution_budget", args: { research_id: "legacy-study", max_seconds: 60, max_executions: 5 } };
      if (results.length === (legacyBinding ? 1 : 0)) return { name: "subagent", args: { agent: "draft-maker", candidate_id: "correlation-only", sandbox: { cwd: "drafts/one/work", read_paths: ["drafts/one/input"], write_paths: ["drafts/one/work"] }, task: "Create the draft from the authorized input." } };
      expect(results.at(-1)!.content).toContain("Draft created"); return "Generic Draft completed.";
    });
    await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi/agents/draft-maker.md"), "---\nexecution_scope: confined\ntools: [read, bash, sandbox_run, write, subagent]\n---\nYou are a draft maker.");
    await mkdir(join(fixture.cwd, "drafts/one/input"), { recursive: true }); await mkdir(join(fixture.cwd, "drafts/one/work"));
    await writeFile(join(fixture.cwd, "drafts/one/input/approved.txt"), "approved");
    await mkdir(join(fixture.cwd, "evaluator")); await writeFile(join(fixture.cwd, "evaluator/private.txt"), "PRIVATE");
    await writeFile(join(fixture.cwd, ".pi-science/protected"), "CONTROL");
    await writeFile(join(fixture.cwd, "research-events.jsonl"), "parent-only");
    const legacyDirectory = join(fixture.cwd, "research/legacy-study/candidates/correlation-only");
    await mkdir(join(legacyDirectory, "input"), { recursive: true });
    await mkdir(join(legacyDirectory, "work"));
    await writeFile(join(legacyDirectory, "input/legacy.txt"), "legacy-input");
    await writeFile(join(legacyDirectory, "work/unchanged.txt"), "legacy-work");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "generic-draft", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "bash", "sandbox_run", "write", "subagent", "execution_budget"], skillPolicy: { mode: "none" } }, "draft-owner");
    expect(await runHiddenPrompt(parent, "Create a Draft", "draft-once", Date.now() + 30_000)).toBe("Generic Draft completed.");
    expect(await readFile(join(fixture.cwd, "drafts/one/work/output.txt"), "utf8")).toBe("approved");
    expect(await readFile(join(fixture.cwd, "research-events.jsonl"), "utf8")).toBe("parent-only");
    expect(await readFile(join(legacyDirectory, "work/unchanged.txt"), "utf8")).toBe("legacy-work");
    const { executionRepository } = await import("../executions/execution-repository.js");
    const records = await executionRepository.list(fixture.cwd);
    expect(records).toEqual([expect.objectContaining({ status: "succeeded", correlation: expect.objectContaining({ candidate_id: "correlation-only" }), request: expect.objectContaining({ execution_grant_id: expect.stringMatching(/^[a-f0-9]{64}$/) }), runtime: expect.objectContaining({ execution_mode: "required" }) })]);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(legacyDirectory, "work"))).toEqual(["unchanged.txt"]);
    expect(await readdir(join(fixture.cwd, ".pi-science/execution-budget-scopes"))).toHaveLength(legacyBinding ? 1 : 0);
  }, 45_000);

  it("returns actionable missing-scope guidance for an unrelated Skill through Worker IPC", async () => {
    const fixture = await modelFixture((body) => {
      const results = body.messages.filter((message) => message.role === "tool");
      if (!results.length) return { name: "subagent", args: { agent: "document-audit/auditor", task: "Read the workspace and audit it." } };
      expect(results.at(-1)!.content).toContain("scope_migration_required");
      expect(results.at(-1)!.content).toContain("missing execution_scope");
      expect(results.at(-1)!.content).toContain("document-audit/agents/auditor.md");
      return "Review and declare the role scope before dispatching a new task.";
    });
    await mkdir(join(fixture.cwd, ".pi/skills/document-audit/agents"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi/skills/document-audit/SKILL.md"), "---\nname: document-audit\ndescription: Audit\nlicense: MIT\n---\nAudit");
    await writeFile(join(fixture.cwd, ".pi/skills/document-audit/agents/auditor.md"), "---\ntools: [read, write]\n---\nYou are an auditor.");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "scope-migration", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "write", "subagent"] }, "scope-migration-owner");
    expect(await runHiddenPrompt(parent, "Delegate the audit", "scope-migration-once", Date.now() + 20_000)).toBe("Review and declare the role scope before dispatching a new task.");
    expect(fixture.requests()).toBe(2);
    const { executionRepository } = await import("../executions/execution-repository.js");
    expect(await executionRepository.list(fixture.cwd)).toEqual([]);
  }, 30_000);

  it("runs source-only research with read/write and no experimental budget capability", async () => {
    const report = "Synthetic source-001: correlation does not establish causation. Synthetic source-002: randomized trial found no clear effect; uncertainty remains. Next action: stop, insufficient evidence of causal benefit.";
    const fixture = await modelFixture((body) => {
      expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(["read", "write"]);
      const results = body.messages.filter((message) => message.role === "tool");
      if (!results.length) return { name: "read", args: { path: ".pi/skills/auto-research/references/literature-research.md" } };
      if (results.length === 1) {
        expect(results[0]!.content).toContain("No execution_budget tool");
        return { name: "write", args: { path: "report.md", content: report } };
      }
      return "Qualified literature report saved.";
    });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const runtime = await openHiddenTask(manager, "lite", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "write"], skillPolicy: { mode: "allowlist", skills: ["auto-research"] } }, "lite-owner");
    expect(await runHiddenPrompt(runtime, "Review the two supplied synthetic sources using Research Lite.", "lite-once", Date.now() + 20_000)).toBe("Qualified literature report saved.");
    expect(await readFile(join(fixture.cwd, "report.md"), "utf8")).toBe(report);
    const { executionRepository } = await import("../executions/execution-repository.js");
    expect(await executionRepository.list(fixture.cwd)).toEqual([]);
    const { workspaceFile } = await import("../../storage/persistence.js");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(workspaceFile(fixture.cwd, "execution-budget-scopes")).catch(() => [])).toEqual([]);
    await expect(readFile(join(fixture.cwd, "manifest.json"))).rejects.toThrow();
  }, 30_000);

  it.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["darwin", "linux"].includes(process.platform))("runs main and authorized child Bash without any enabled Skill", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const fixture = await modelFixture((body) => {
      if (body.messages[0]!.content.includes("You are an isolated runner")) return body.messages.some((message) => message.role === "tool") ? "Child isolated." : { name: "bash", args: { command: "printf child > child.txt; ! cat .pi-science/protected; echo child-isolated" } };
      const tools = body.messages.filter((message) => message.role === "tool");
      if (!tools.length) return { name: "bash", args: { command: "printf main > main.txt; echo main-isolated" } };
      if (tools.length === 1) return { name: "subagent", args: { agent: "runner", task: "Run your authorized Bash command." } };
      expect(tools.at(-1)!.content).toContain("Child isolated."); return "Main and child completed.";
    });
    await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi/agents/runner.md"), "---\nname: runner\ndescription: Isolated command runner\ntools: [bash]\n---\nYou are an isolated runner.");
    await writeFile(join(fixture.cwd, ".pi-science/protected"), "SECRET");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "universal-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["bash", "subagent"], skillPolicy: { mode: "none" } }, "universal-owner");
    expect(await runHiddenPrompt(parent, "Run main and child", "universal-once", Date.now() + 30_000)).toBe("Main and child completed.");
    expect(await readFile(join(fixture.cwd, "main.txt"), "utf8")).toBe("main");
    expect(await readFile(join(fixture.cwd, "child.txt"), "utf8")).toBe("child");
    const { executionRepository } = await import("../executions/execution-repository.js");
    expect((await executionRepository.list(fixture.cwd)).filter((record) => record.producer === "bash").map((record) => record.status)).toEqual(["succeeded", "succeeded"]);
  }, 45_000);

  it.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["darwin", "linux"].includes(process.platform))("repairs a candidate through universal Bash, independently evaluates it and obtains Reviewer stop advice", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    let repairs = 0; let score: number | undefined;
    const fixture = await modelFixture(async (body) => {
      const system = body.messages[0]!.content;
      const results = body.messages.filter((message) => message.role === "tool");
      if (system.includes("You are an experimenter subagent")) {
        expect((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual(["read", "bash"]);
        if (!results.length) { repairs++; return { name: "bash", args: { command: "python3 -I -c \"raise ValueError('repair-me')\"" } }; }
        if (results.length === 1) { expect(results[0]!.content).toContain("repair-me"); repairs++; return { name: "bash", args: { command: "python3 -I -c \"import json,pathlib; pathlib.Path('output.json').write_text(json.dumps({'prediction': 42})); print('repaired')\"" } }; }
        return "Candidate repaired with actual Bash output.";
      }
      if (system.includes("You are an independent reviewer")) { expect(score).toBe(0); return "PASS. Stop: independent evaluation met the frozen target."; }
      if (!results.length) return { name: "execution_budget", args: { research_id: "universal-study", max_seconds: 45, max_executions: 8 } };
      if (results.length === 1) return { name: "bash", args: { command: "python3 -I research/universal-study/evaluator.py research/universal-study/baseline-input.json research/universal-study/baseline.json" } };
      if (results.length === 2) { expect(results[1]!.content).toContain('"loss": 1764'); return { name: "subagent", args: { agent: "auto-research/experimenter", candidate_id: "one", task: "Generate a prediction, execute and repair from real errors." } }; }
      if (results.length === 3) return { name: "bash", args: { command: "python3 -I research/universal-study/evaluator.py research/universal-study/candidates/one/work/output.json research/universal-study/result.json" } };
      if (results.length === 4) {
        score = JSON.parse(results[3]!.content.split("\n")[0]!).loss;
        return { name: "subagent", args: { agent: "auto-research/reviewer", task: `Review Parent evaluator loss=${score}; baseline=1764, target=0. Recommend stopping or continuing.` } };
      }
      expect(results.at(-1)!.content).toContain("Stop"); return "Stopped after independent evaluation and review.";
    });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    const directory = join(fixture.cwd, "research/universal-study/candidates/one");
    await mkdir(join(directory, "input"), { recursive: true }); await mkdir(join(directory, "work"));
    await writeFile(join(fixture.cwd, "research/universal-study/baseline-input.json"), '{"prediction":0}');
    await writeFile(join(fixture.cwd, "research/universal-study/evaluator.py"), "import json,sys,hashlib,pathlib\nscore=lambda value:(value-42)**2\nassert score(42)==0 and score(0)==1764\nsource=pathlib.Path(sys.argv[1]).read_bytes()\nresult={'loss':score(json.loads(source)['prediction']),'validity':True,'evaluator_digest':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'data_digest':hashlib.sha256(source).hexdigest(),'environment':sys.version}\npathlib.Path(sys.argv[2]).write_text(json.dumps(result))\nprint(json.dumps(result))");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "candidate-bash-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "bash", "execution_budget", "subagent"] }, "candidate-bash-owner");
    expect(await runHiddenPrompt(parent, "Execute, evaluate and review", "candidate-bash-once", Date.now() + 45_000)).toBe("Stopped after independent evaluation and review.");
    expect(repairs).toBe(2); expect(score).toBe(0);
    const { executionRepository } = await import("../executions/execution-repository.js");
    expect((await executionRepository.list(fixture.cwd)).filter((record) => record.producer === "bash").map((record) => record.status).sort()).toEqual(["failed", "succeeded", "succeeded", "succeeded"]);
    const { workspaceFile } = await import("../../storage/persistence.js"); const { createHash } = await import("node:crypto");
    const budget = JSON.parse(await readFile(workspaceFile(fixture.cwd, `execution-budgets/${createHash("sha256").update("research:universal-study").digest("hex")}.json`), "utf8"));
    expect(budget.used).toBe(6);
    const records = await executionRepository.list(fixture.cwd);
    const evaluated = records.find((record) => (record.request.command as string[] | undefined)?.some((arg) => arg.includes("work/output.json")))!;
    expect(evaluated).toMatchObject({ status: "succeeded", runtime: { execution_mode: "required" }, artifacts: [expect.objectContaining({ relation: "output" })] });
    const version = JSON.parse(await readFile(join(fixture.cwd, "research/universal-study/result.json"), "utf8"));
    expect(version.evaluator_digest).toMatch(/^[a-f0-9]{64}$/);
    await manager.stop("candidate-bash-parent");
    const reopened = await openHiddenTask(manager, "candidate-bash-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "bash", "execution_budget", "subagent"] }, "candidate-bash-owner");
    expect(await runHiddenPrompt(reopened, "Execute, evaluate and review", "candidate-bash-once", Date.now() + 10_000)).toBe("Stopped after independent evaluation and review.");
    expect(await executionRepository.list(fixture.cwd)).toHaveLength(records.length);
  }, 60_000);

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

  it("inherits a new authorized MCP provider without editing the researcher role, through real child IPC", async () => {
    const fixture = await modelFixture((body) => {
      const system = body.messages[0]!.content;
      const completed = body.messages.filter((item) => item.role === "tool").length;
      if (system.includes("You are a research subagent")) {
        if (!completed) return { name: "mcp__fresh-library__search_papers", args: {} };
        if (completed === 1) return { name: "mcp__fresh-library__retrieve_paper", args: {} };
        return "Source URL https://example.org/paper; retrieved fixture evidence. responseId is temporary.";
      }
      if (!completed) return { name: "execution_budget", args: { research_id: "retrieval-study", max_executions: 3, max_seconds: 30 } };
      if (completed === 1) return { name: "subagent", args: { agent: "auto-research/researcher", task: "Search then fetch evidence; return original URL and excerpt." } };
      return "Researcher evidence saved for synthesis.";
    });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    const server = join(fixture.cwd, "mcp-fixture.mjs");
    await writeFile(server, [
      `import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
      `const server = new McpServer({ name: "web-fixture", version: "1" });`,
      `for (const name of ["search_papers", "retrieve_paper"]) server.registerTool(name, { description: name }, async () => ({ content: [{ type: "text", text: "https://example.org/paper: fixture evidence" }] }));`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n"));
    await writeFile(join(fixture.cwd, ".pi-science/mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "retrieval_project", mcpServers: {
      "fresh-library": { command: process.execPath, args: [server], approveTools: true,
        __piScienceAllowedTools: ["search_papers", "retrieve_paper"], __piScienceConnectorId: "connector_web", __piScienceConnectorRevision: 1, __piScienceSettingsRevision: 1 },
    } }));
    const authority = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ decision: "allow" }));
    });
    await new Promise<void>((resolve) => authority.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { authority.closeAllConnections(); authority.close(() => resolve()); }));
    const policyUrl = `http://127.0.0.1:${(authority.address() as { port: number }).port}`;
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "retrieval-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"),
      env: { PI_SCIENCE_BACKEND_URL: policyUrl },
      model: fixture.model, thinking: "off", allowedTools: ["read", "subagent", "execution_budget", "mcp__fresh-library__search_papers", "mcp__fresh-library__retrieve_paper"] }, "retrieval-owner");
    const interactions: unknown[] = []; parent.on("event", (event) => { if (event.type === "interaction.requested") interactions.push(event); });
    expect(await runHiddenPrompt(parent, "Retrieve evidence", "retrieval-once", Date.now() + 30000)).toContain("evidence saved");
    const history = await new AgentSessionRepository().messages(fixture.cwd, parent.sessionId);
    const delegated = history.find((item) => item.toolName === "subagent")!;
    expect(delegated).toMatchObject({ details: { results: [{ exitCode: 0, output: expect.stringContaining("https://example.org/paper") }] } });
    const details = delegated.details as { results: Array<{ childSessionId: string }> };
    const child = await new AgentSessionRepository().messages(fixture.cwd, details.results[0]!.childSessionId);
    expect(child.filter((item) => item.role === "toolResult").map((item) => item.toolName)).toEqual(["mcp__fresh-library__search_papers", "mcp__fresh-library__retrieve_paper"]);
    expect(interactions).toEqual([]);
    const { executionBudgetTools } = await import("./worker/execution-budget.js");
    const budget = executionBudgetTools(fixture.cwd);
    const status = await budget.tool.execute("resume", { research_id: "retrieval-study" }, () => {}, { env: {} as NodeExecutionEnv },
      { operationId: "resume-operation", invocationId: "resume", turnId: "resume", getMemo: async () => undefined, setMemo: async () => {} }, BACKGROUND_CONTEXT);
    expect(status.details).toMatchObject({ used: 3, remaining_executions: 0 });
  }, 40000);

  it("discovers the experimenter with read-only code generation and checks live role revocation before a child tool call", async () => {
    let parent: Awaited<ReturnType<typeof openHiddenTask>>;
    let checkedRevocation = false;
    const fixture = await modelFixture(async (body) => {
      const system = body.messages[0]!.content;
      if (system.includes("You are an experimenter subagent")) {
        const names = (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
        expect(names).toEqual(["read", "bash"]);
        if (!body.messages.some((item) => item.role === "tool")) {
          await parent.sendCommand("set_skill_policy", { policy: { mode: "none" } });
          return { name: "read", args: { path: "private.txt" } };
        }
        expect(JSON.stringify(body.messages)).toContain("disabled agent");
        expect(JSON.stringify(body.messages)).not.toContain("PRIVATE CONTENT");
        checkedRevocation = true;
        return "Candidate generation blocked by revoked skill; no execution performed.";
      }
      if (!body.messages.some((item) => item.role === "tool")) return { name: "subagent", args: { agent: "auto-research/experimenter", task: "Read private.txt and propose candidate-001." } };
      return "Revocation respected.";
    });
    const { seedWorkspaceAssets } = await import("./runtime-config.js"); seedWorkspaceAssets(fixture.cwd);
    await writeFile(join(fixture.cwd, "private.txt"), "PRIVATE CONTENT");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    parent = await openHiddenTask(manager, "experiment-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"),
      model: fixture.model, thinking: "off", allowedTools: ["read", "write", "bash", "subagent"] }, "experiment-owner");
    expect(await runHiddenPrompt(parent, "Generate a candidate", "experiment-once", Date.now() + 20000)).toBe("Revocation respected.");
    expect(checkedRevocation).toBe(true);
  }, 30000);

  it("denies a renamed restricted role's unbound workspace reads through real child IPC in code-generation mode", async () => {
    const fixture = await modelFixture((body) => {
      const completed = body.messages.filter((item) => item.role === "tool");
      if (body.messages[0]!.content.includes("You are a confined optimizer")) {
        if (!completed.length) return { name: "read", args: { path: "research/protected/evaluation.yaml" } };
        expect(JSON.stringify(completed)).toContain("bound candidate_id");
        expect(JSON.stringify(completed)).not.toContain("HIDDEN EVALUATOR SENTINEL");
        return "Proposed code from supplied task text; workspace read denied.";
      }
      return !completed.length ? { name: "subagent", args: { agent: "optimizer", task: "Read research/protected/evaluation.yaml and generate code." } } : "Protected code-generation mode.";
    });
    await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi/agents/optimizer.md"), "---\nexecution_scope: candidate\ntools: [read, bash]\n---\nYou are a confined optimizer.");
    await mkdir(join(fixture.cwd, "research/protected"), { recursive: true }); await writeFile(join(fixture.cwd, "research/protected/evaluation.yaml"), "HIDDEN EVALUATOR SENTINEL");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "unbound-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["read", "subagent"] }, "unbound-owner");
    expect(await runHiddenPrompt(parent, "Generate candidate code", "unbound-once", Date.now() + 20000)).toBe("Protected code-generation mode.");
  }, 30000);

  it("does not expose the retired sandbox_run tool through Worker IPC", async () => {
    const fixture = await modelFixture((body) => {
      const names = (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
      expect(names).toContain("read");
      expect(names).not.toContain("sandbox_run");
      return "Legacy tool removed.";
    });
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "retired-tool-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"),
      model: fixture.model, thinking: "off", allowedTools: ["read", "sandbox_run"] }, "retired-tool-owner");
    expect(await runHiddenPrompt(parent, "Inspect tools", "retired-tool-once", Date.now() + 20000)).toBe("Legacy tool removed.");
  }, 30000);

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
    for (const child of children) expect(child.tools.map((tool) => (tool as { function: { name: string } }).function.name)).toEqual(expect.arrayContaining(["read", "subagent", "execution_budget"]));
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
    // This legacy evaluator intentionally uses administrator-authorized host execution.
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
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
    const { executionRepository } = await import("../executions/execution-repository.js");
    expect((await executionRepository.list(fixture.cwd)).find((record) => record.producer === "bash")?.result.error).toBeUndefined();
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

describe("durable subagent supervision", () => {
  it("collects background results after the execution quota is spent and replays without respawning", async () => {
    const fixture = await modelFixture(async (body) => {
      if (body.messages[0]!.content.includes("bounded background runner")) return "Background result.";
      const tools = body.messages.filter((message) => message.role === "tool");
      if (!tools.length) return { name: "execution_budget", args: { max_executions: 1, max_seconds: 30 } };
      if (tools.length === 1) return { name: "subagent", args: { agent: "background", task: "Return a result.", tools: [], budget: { max_executions: 1 }, wait_seconds: 0 } };
      if (tools.length === 2) {
        expect(tools[1]!.content).toContain('"status":"running"');
        const taskId = tools[1]!.content.match(/"task_id":"([a-f0-9]{64})"/)![1];
        return { name: "subagent_control", args: { action: "collect", task_id: taskId, wait_seconds: 20 } };
      }
      expect(tools.at(-1)!.content).toContain("Background result."); return "Collected background result.";
    });
    await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi/agents/background.md"), "---\nname: background\ntools: []\n---\nYou are a bounded background runner.");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const options = { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off" as const, allowedTools: ["execution_budget", "subagent", "subagent_control"] };
    const parent = await openHiddenTask(manager, "background-parent", options, "owner");
    expect(await runHiddenPrompt(parent, "Run and collect", "once", Date.now() + 30_000)).toBe("Collected background result.");
    const requests = fixture.requests(); await manager.stop("background-parent");
    const reopened = await openHiddenTask(manager, "background-parent", options, "owner");
    expect(await runHiddenPrompt(reopened, "Run and collect", "once", Date.now() + 10_000)).toBe("Collected background result.");
    expect(fixture.requests()).toBe(requests);
  }, 45_000);

  it.each(["stop", "deadline"])("terminates a child waiting for a model response on %s", async (mode) => {
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    const fixture = await modelFixture(async (body) => {
      if (body.messages[0]!.content.includes("blocked background runner")) { started(); await blocked; return "late child"; }
      const tools = body.messages.filter((message) => message.role === "tool");
      if (!tools.length) return { name: "subagent", args: { agent: "blocked", task: "Wait for a model response.", wait_seconds: 0, budget: { max_seconds: mode === "deadline" ? 8 : 30 } } };
      if (tools.length === 1) {
        await childStarted;
        return { name: "subagent_control", args: { action: mode === "stop" ? "stop" : "collect", task_id: tools[0]!.content.match(/"task_id":"([a-f0-9]{64})"/)![1], wait_seconds: 10 } };
      }
      expect(tools.at(-1)!.content).toMatch(mode === "stop" ? /cancelled/ : /deadline|aborted/i);
      return "Child terminated.";
    });
    await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(fixture.cwd, ".pi/agents/blocked.md"), "---\nname: blocked\ntools: []\n---\nYou are a blocked background runner.");
    const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
    const parent = await openHiddenTask(manager, "blocked-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["subagent", "subagent_control"] }, "owner");
    try { expect(await runHiddenPrompt(parent, "Run a child", "once", Date.now() + 30_000)).toBe("Child terminated."); }
    finally { release(); }
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(fixture.cwd, ".pi-science/agent-tasks", createHash("sha256").update(parent.sessionId).digest("hex")));
    const record = JSON.parse(await readFile(join(fixture.cwd, ".pi-science/agent-tasks", createHash("sha256").update(parent.sessionId).digest("hex"), files.find((name) => name.endsWith(".json"))!), "utf8"));
    expect(record.status).toBe(mode === "stop" ? "cancelled" : "timed_out");
  }, 45_000);
});

it("recovers a child result committed before its task summary without restarting the child or spending again", async () => {
  let childCalls = 0, taskId = "";
  const fixture = await modelFixture((body) => {
    if (body.messages[0]!.content.includes("checkpointed result runner")) { childCalls++; return "Committed child result."; }
    const start = body.messages.findLastIndex((message) => message.role === "user");
    const tools = body.messages.slice(start).filter((message) => message.role === "tool");
    if (body.messages[start]!.content.includes("Recover pending task")) {
      if (!tools.length) return { name: "subagent_control", args: { action: "collect", task_id: taskId, wait_seconds: 10 } };
      expect(tools.at(-1)!.content).toContain("Committed child result."); return "Recovered.";
    }
    if (!tools.length) return { name: "subagent", args: { agent: "checkpointed", task: "Return the result.", wait_seconds: 0 } };
    taskId = tools[0]!.content.match(/"task_id":"([a-f0-9]{64})"/)![1]!; return "Dispatched.";
  });
  await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(fixture.cwd, ".pi/agents/checkpointed.md"), "---\nname: checkpointed\ntools: []\n---\nYou are a checkpointed result runner.");
  const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
  const options = { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off" as const, allowedTools: ["subagent", "subagent_control"] };
  const parent = await openHiddenTask(manager, "checkpointed-parent", options, "owner");
  expect(await runHiddenPrompt(parent, "Dispatch a task", "dispatch", Date.now() + 30_000)).toBe("Dispatched.");
  const path = join(fixture.cwd, ".pi-science/agent-tasks", createHash("sha256").update(parent.sessionId).digest("hex"), `${taskId}.json`);
  await vi.waitFor(async () => expect(JSON.parse(await readFile(path, "utf8")).status).toBe("completed"), { timeout: 15_000 });
  await manager.stop("checkpointed-parent");
  const record = JSON.parse(await readFile(path, "utf8"));
  const { result: _result, ...unfinished } = record;
  // Reproduce the durable crash boundary: child result is committed, group
  // summary has not landed. Keep its original invocation/budget identity.
  const { writeJsonAtomic } = await import("../../storage/persistence.js");
  await writeJsonAtomic(path, { ...unfinished, status: "running" });
  const reopened = await openHiddenTask(manager, "checkpointed-parent", { ...options, allowedTools: ["subagent_control"] }, "owner");
  expect(await reopened.sendCommand("get_state")).toMatchObject({ success: true, data: { activeTools: ["subagent_control"] } });
  expect(await runHiddenPrompt(reopened, "Recover pending task", "recover", Date.now() + 20_000)).toBe("Recovered.");
  expect(childCalls).toBe(1);
  const { ExecutionBudgetLedger } = await import("../executions/execution-budget.js");
  expect(await new ExecutionBudgetLedger(fixture.cwd, record.budget_owner, true).status()).toMatchObject({ used: 1, usage: { subagent: 1 } });
}, 45_000);

it("keeps an idle parent and its workspace active while a background child is running", async () => {
  let release!: () => void, started!: () => void;
  const childStarted = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fixture = await modelFixture(async (body) => {
    if (body.messages[0]!.content.includes("idle background runner")) { started(); await blocked; return "Child finished."; }
    if (body.messages.findLast((message) => message.role === "user")!.content.includes("Keep waiting")) return "Waiting.";
    if (!body.messages.some((message) => message.role === "tool")) return { name: "subagent", args: { agent: "idle", task: "Wait.", wait_seconds: 0 } };
    return "Dispatched.";
  });
  await mkdir(join(fixture.cwd, ".pi/agents"), { recursive: true });
  await writeFile(join(fixture.cwd, ".pi/agents/idle.md"), "---\nname: idle\ntools: []\n---\nYou are an idle background runner.");
  const manager = new AgentRuntimeManager(); cleanup.push(() => manager.shutdownAll());
  const parent = await openHiddenTask(manager, "idle-parent", { cwd: fixture.cwd, sessionsRoot: join(fixture.cwd, ".pi-science/agent-sessions"), model: fixture.model, thinking: "off", allowedTools: ["subagent", "subagent_control"] }, "owner");
  try {
    expect(await runHiddenPrompt(parent, "Dispatch", "dispatch", Date.now() + 30_000)).toBe("Dispatched.");
    await childStarted;
    vi.stubEnv("PI_SCIENCE_IDLE_RUNTIME_MS", "50");
    expect(await runHiddenPrompt(parent, "Keep waiting", "waiting", Date.now() + 10_000)).toBe("Waiting.");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(manager.get("idle-parent")).toBe(parent);
    const { hasActiveWorkspaceRuntimes, closeIdleWorkspaceRuntimes } = await import("./agent-runtime-manager.js");
    expect(await hasActiveWorkspaceRuntimes(fixture.cwd)).toBe(true);
    await expect(closeIdleWorkspaceRuntimes(fixture.cwd)).rejects.toThrow();
  } finally { release(); vi.stubEnv("PI_SCIENCE_IDLE_RUNTIME_MS", "0"); }
}, 45_000);
