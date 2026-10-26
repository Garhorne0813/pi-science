import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type AgentLane, type AgentHarness, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createAssistantMessageEventStream, getSystemMessageText, normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentRuntimeStartOptions } from "./protocol.js";
import type { agentModels } from "./agent-models.js";
import { SessionRuntime } from "./session-runtime.js";
import { AgentMcpTools } from "./mcp-tools.js";
import { networkGrantsPath, readNetworkGrants } from "../../sandbox/network-grants.js";
import { InteractionBridge } from "./interaction-bridge.js";

const roots: string[] = [];
const runtimes: SessionRuntime[] = [];
const context = BACKGROUND_CONTEXT;

async function runtime(prepare?: (cwd: string) => Promise<void>, options: Partial<AgentRuntimeStartOptions> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-science-worker-mutations-")));
  roots.push(cwd);
  if (prepare) await prepare(cwd);
  const events: Array<Record<string, unknown>> = [];
  const instance = await SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
    model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinking: "low",
    env: { PATH: process.env.PATH ?? "", OPENAI_API_KEY: "model-test-secret", PI_SCIENCE_INTERNAL_TOKEN: "server-test-secret" },
    ...options,
  }, (event) => events.push(event), (error) => { throw error; });
  runtimes.push(instance);
  await instance.command("activate", {});
  return { instance, events, parts: instance as unknown as { lane: AgentLane; harness: AgentHarness; executionEnv: NodeExecutionEnv; models: ReturnType<typeof agentModels> } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.allSettled(runtimes.splice(0).map((instance) => instance.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent-core worker mutations", () => {
  it('registers main Memory tools from worker-only credentials while keeping tool shell credentials filtered',async()=>{
    const tools=['search_memory','read_memory','write_memory'];
    const {instance,parts}=await runtime(undefined,{allowedTools:tools,env:{PI_SCIENCE_BACKEND_URL:'http://127.0.0.1:1',PI_SCIENCE_INTERNAL_TOKEN:'memory-test-secret'}});
    expect((await parts.harness.getTools(context)).map(tool=>tool.name)).toEqual(expect.arrayContaining(tools));
    expect(await instance.command('get_state',{})).toMatchObject({data:{activeTools:expect.arrayContaining(tools)}});
    const {toolEnvironment}=await import('../agent-runtime-environment.js');expect(toolEnvironment({PI_SCIENCE_BACKEND_URL:'url',PI_SCIENCE_INTERNAL_TOKEN:'secret'})).toEqual({});
  });
  it.each([{delegatedAgent:'limited-worker'},{executionScope:'candidate' as const}])('denies Memory to delegated/confined workers despite model-requested tool names: %j',async(binding)=>{
    const {parts}=await runtime(undefined,{...binding,allowedTools:['search_memory','read_memory','write_memory'],env:{PI_SCIENCE_BACKEND_URL:'http://127.0.0.1:1',PI_SCIENCE_INTERNAL_TOKEN:'memory-test-secret'}});
    expect((await parts.harness.getTools(context)).map(tool=>tool.name).filter(name=>name.endsWith('_memory'))).toEqual([]);
  });
  it("exposes connector discovery failures in the runtime snapshot", async () => {
    const { instance } = await runtime(async (cwd) => {
      await mkdir(join(cwd, ".pi-science"), { recursive: true });
      await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test", mcpServers: {
        unavailable: { command: process.execPath, args: [], __piScienceConnectorId: "missing-connector", __piScienceEnvironment: { TOKEN: { kind: "environment", name: "PI_TEST_MISSING_MCP_TOKEN" } } },
      } }));
    });
    expect(await instance.command("get_state", {})).toMatchObject({ success: true, data: { mcpDiagnostics: ["unavailable: Missing MCP environment variable: PI_TEST_MISSING_MCP_TOKEN"] } });
  });

  it("does not cancel a settled budget when its watch notification is delayed", async () => {
    const { instance } = await runtime();
    const state = instance as unknown as { watchedBudgetOperation?: string; budgetTools: ReturnType<typeof import("./execution-budget.js").executionBudgetTools> };
    const ledger = state.budgetTools.ledger("settled-operation");
    await ledger.configure({ max_executions: 3 }, "settled-research");
    // Deterministically reproduce an idle lane before the watcher catches up.
    state.watchedBudgetOperation = "settled-operation";
    await instance.command("abort", {});
    expect(await ledger.status()).toMatchObject({ cancelled: false, remaining_executions: 3 });
  });

  it.each([{ executionScope: "candidate" as const }, { sandboxCandidateId: "one" }])("applies the Candidate tool ceiling before MCP discovery: %j", async (binding) => {
    const cwd = resolve(await mkdtemp(join(tmpdir(), "runtime-candidate-tools-"))); roots.push(cwd);
    const discover = vi.spyOn(AgentMcpTools, "open");
    const instance = await SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science/agent-sessions"), ...binding,
      allowedTools: ["read", "bash", "write", "edit", "subagent", "ask_user_question", "mcp__local__echo"],
      model: { provider: "openai", modelId: "gpt-4.1-mini" },
    }, () => {}, (error) => { throw error; });
    runtimes.push(instance);
    expect(discover).not.toHaveBeenCalled();
    expect(await instance.command("get_state", {})).toMatchObject({ success: true, data: { activeTools: ["read", "bash"] } });
  });

  it.each([{ allowedTools: [] }, { allowedTools: ["read", "subagent"] }])("does not initialize configured MCP connectors for capabilities $allowedTools", async ({ allowedTools }) => {
    const cwd = resolve(await mkdtemp(join(tmpdir(), "pi-science-worker-no-mcp-")));
    roots.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    const marker = join(cwd, "connector-started");
    await writeFile(join(cwd, ".pi-science", "mcp-runtime.json"), JSON.stringify({ version: 1, project_id: "project_test",
      mcpServers: {
        stdio: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
          __piScienceConnectorId: "connector_stdio" },
        http: { transport: "streamable_http", url: "https://unused.example/mcp", __piScienceConnectorId: "connector_http",
          __piScienceHeaders: { Authorization: { kind: "environment", name: "UNCONFIGURED_CONNECTOR_SECRET" } } },
        sse: { transport: "sse", url: "https://unused.example/sse", __piScienceConnectorId: "connector_sse" },
      } }));
    const discover = vi.spyOn(AgentMcpTools, "open");
    const instance = await SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"), allowedTools,
      model: { provider: "openai", modelId: "gpt-4.1-mini" }, skillPolicy: { mode: "none" },
    }, () => undefined, (error) => { throw error; });
    runtimes.push(instance);
    expect(discover).not.toHaveBeenCalled();
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    expect(await instance.command("get_state", {})).toMatchObject({ success: true, data: { activeTools: allowedTools } });
    await instance.close(); // Optional MCP ownership also works on disposal.
  });

  it.each([{ allowedTools: undefined }, { allowedTools: ["mcp__local__echo"] }])("still discovers MCP when capabilities permit it: $allowedTools", async ({ allowedTools }) => {
    const cwd = resolve(await mkdtemp(join(tmpdir(), "pi-science-worker-with-mcp-")));
    roots.push(cwd);
    const mcp = new AgentMcpTools();
    const discover = vi.spyOn(AgentMcpTools, "open").mockResolvedValue(mcp);
    const close = vi.spyOn(mcp, "close");
    const instance = await SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"), allowedTools,
      model: { provider: "openai", modelId: "gpt-4.1-mini" },
    }, () => undefined, (error) => { throw error; });
    runtimes.push(instance);
    expect(discover).toHaveBeenCalledOnce();
    await instance.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("activates native web tools without exposing the retired MCP tool names", async () => {
    const { instance, parts } = await runtime();
    const names = (await parts.harness.getTools(context)).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    expect(names.some((name) => name.startsWith("mcp__web-access__"))).toBe(false);
    expect(await instance.command("get_state", {})).toMatchObject({ success: true, data: { activeTools: expect.arrayContaining(["web_search", "web_fetch"]) } });
  });

  it("reports pending browser interactions in worker snapshots until they are answered", async () => {
    const { instance, events } = await runtime();
    const bridge = (instance as unknown as { interactions: InteractionBridge }).interactions;
    const request = bridge.request("Confirm", "");
    expect(await instance.command("get_state", {})).toMatchObject({ data: { pendingInteraction: true } });
    bridge.notify("extension_ui_response", { id: events.at(-1)!.id, value: "confirmed" });
    expect(await request).toBe("confirmed");
    expect(await instance.command("get_state", {})).toMatchObject({ data: { pendingInteraction: false } });
  });

  it("rolls back a partial failure before another configuration can commit", async () => {
    const { instance, parts } = await runtime();
    const setThinking = parts.lane.setThinkingLevel.bind(parts.lane);
    vi.spyOn(parts.lane, "setThinkingLevel").mockImplementation(async (level, ctx) => {
      if (level === "medium") throw new Error("injected configuration failure");
      return setThinking(level, ctx);
    });
    const [failed, committed] = await Promise.all([
      instance.command("configure", { provider: "openai", modelId: "gpt-5", level: "medium" }),
      instance.command("configure", { provider: "openai", modelId: "gpt-5-mini", level: "high" }),
    ]);
    expect(failed).toMatchObject({ success: false });
    expect(committed).toMatchObject({ success: true });
    expect(await instance.command("get_state", {})).toMatchObject({ success: true,
      data: { model: { provider: "openai", modelId: "gpt-5-mini" }, thinkingLevel: "high" } });
  });

  it("validates the complete configuration before changing the durable lane", async () => {
    const { instance } = await runtime();
    expect(await instance.command("configure", { provider: "openai", modelId: "gpt-4.1", level: "invalid" }))
      .toMatchObject({ success: false, code: "invalid_thinking" });
    expect(await instance.command("set_model", { provider: "openai", modelId: "not-a-model" }))
      .toMatchObject({ success: false, code: "invalid_model" });
    expect(await instance.command("get_state", {})).toMatchObject({ success: true,
      data: { model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinkingLevel: "off" } });
  });

  it("round trips network approval through the runtime browser channel", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "runtime-network-home-"))); roots.push(home); vi.stubEnv("PI_SCIENCE_HOME", home);
    const { instance, parts, events } = await runtime();
    const mainTools = await parts.harness.getTools(context);
    expect(mainTools.some((tool) => tool.name === "ask_user_question")).toBe(true);
    const tool = mainTools.find((tool) => tool.name === "request_network_access")!;
    expect(tool).toBeDefined();
    const pending = tool.execute("network-1", { domain: "api.example.org", reason: "Read research data" }, () => {}, { env: parts.executionEnv }, {} as never, context);
    await vi.waitFor(() => expect(events.some((event) => event.type === "interaction.requested")).toBe(true));
    const event = events.find((event) => event.type === "interaction.requested")!;
    expect(await instance.command("get_state", {})).toMatchObject({ data: { pendingInteraction: true } });
    expect(instance.notify("extension_ui_response", { id: event.id, value: "allow" })).toMatchObject({ success: true });
    expect(await pending).toMatchObject({ details: { status: "granted" } });
    expect((await readNetworkGrants()).rules).toMatchObject([{ profile: "analysis", domain: "api.example.org", decision: "allow" }]);
    expect(networkGrantsPath()).toContain(home);
  });

  it.each([{ sandboxCandidateId: "candidate-test" }, { delegatedAgent: "worker" }])("withholds direct network approvals from confined/delegated workers: %j", async (binding) => {
    const cwd = resolve(await mkdtemp(join(tmpdir(), "runtime-network-confined-"))); roots.push(cwd);
    const instance = await SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"), allowedTools: ["read", "request_network_access"], ...binding,
      model: { provider: "openai", modelId: "gpt-4.1-mini" } }, () => {}, (error) => { throw error; });
    runtimes.push(instance);
    expect(await instance.command("get_state", {})).toMatchObject({ data: { activeTools: ["read"] } });
  });

  it("keeps abort reachable while a configuration mutation is waiting", async () => {
    const { instance, parts } = await runtime();
    let release!: () => void;
    const blocked = new Promise<void>((resolveGate) => { release = resolveGate; });
    const setThinking = parts.lane.setThinkingLevel.bind(parts.lane);
    const setter = vi.spyOn(parts.lane, "setThinkingLevel").mockImplementation(async (level, ctx) => {
      await blocked;
      return setThinking(level, ctx);
    });
    const configure = instance.command("configure", { provider: "openai", modelId: "gpt-5", level: "high" });
    try {
      await vi.waitFor(() => expect(setter).toHaveBeenCalled());
      expect(await instance.command("abort", {})).toMatchObject({ success: false }); // No active model operation.
    } finally { release(); }
    expect(await configure).toMatchObject({ success: true });
  });

  it("keeps the durable model at start so only a verified configure can change it", async () => {
    const cwd = resolve(await mkdtemp(join(tmpdir(), "pi-science-worker-model-request-")));
    roots.push(cwd);
    const options = { cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
      model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinking: "low" as const,
      env: { PATH: process.env.PATH ?? "", OPENAI_API_KEY: "model-test-secret", PI_SCIENCE_INTERNAL_TOKEN: "server-test-secret" } };
    const first = await SessionRuntime.open(options, () => undefined, (error) => { throw error; });
    runtimes.push(first);
    await first.command("activate", {});

    // A start must not commit the model it was asked for: the request may still be rejected by
    // the configure that follows, and then the session would run on a model it refused.
    const second = await SessionRuntime.open({ ...options, sessionId: first.sessionId,
      model: { provider: "deepseek", modelId: "deepseek-v4-pro" } }, () => undefined, (error) => { throw error; });
    runtimes.push(second);
    await second.command("activate", {});

    expect(await second.command("get_state", {})).toMatchObject({
      success: true, data: { model: { provider: "openai", modelId: "gpt-4.1-mini" } } });
  }, 20_000);

  it("adopts the requested model when the durable one is no longer in the catalog", async () => {
    const cwd = resolve(await mkdtemp(join(tmpdir(), "pi-science-worker-model-adopt-")));
    roots.push(cwd);
    const options = { cwd, sessionsRoot: join(cwd, ".pi-science", "agent-sessions"),
      model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinking: "low" as const,
      env: { PATH: process.env.PATH ?? "", OPENAI_API_KEY: "model-test-secret", PI_SCIENCE_INTERNAL_TOKEN: "server-test-secret" } };
    const first = await SessionRuntime.open(options, () => undefined, (error) => { throw error; });
    runtimes.push(first);
    await first.command("activate", {});
    // Leave the session on a model the catalog does not contain, which is what disabling a
    // provider does. The session has to stay openable instead of failing before it can be
    // reconfigured, so the requested model is adopted and becomes the durable one.
    await (first as unknown as { lane: AgentLane }).lane.setModel({ provider: "openai", modelId: "gone" }, context);

    const second = await SessionRuntime.open({ ...options, sessionId: first.sessionId,
      model: { provider: "deepseek", modelId: "deepseek-v4-pro" } }, () => undefined, (error) => { throw error; });
    runtimes.push(second);
    await second.command("activate", {});

    expect(await second.command("get_state", {})).toMatchObject({
      success: true, data: { model: { provider: "deepseek", modelId: "deepseek-v4-pro" } } });
  }, 20_000);

  it("lists the allowed skill and prompt commands and drops a skill once its policy disables it", async () => {
    const { instance } = await runtime(async (cwd) => {
      await mkdir(join(cwd, ".pi", "skills", "review"), { recursive: true });
      await writeFile(join(cwd, ".pi", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review evidence\n---\nFollow the evidence protocol.");
      await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
      await writeFile(join(cwd, ".pi", "prompts", "summarize.md"), "---\ndescription: Summarize text\n---\nSummarize the following text: $ARGUMENTS");
    });
    expect(await instance.command("get_commands", {})).toMatchObject({ success: true, data: { commands: expect.arrayContaining([
      { name: "skill:review", description: "Review evidence", source: "skill", group: "skill" },
      { name: "summarize", description: "Summarize text", source: "prompt", group: "utility" }]) } });
    expect(await instance.command("set_skill_policy", { policy: { mode: "none" } })).toMatchObject({ success: true });
    // The prompt command survives the disable, and the disabled skill is both absent from the
    // catalogue and rejected when a client invokes it by name.
    expect(await instance.command("get_commands", {})).toMatchObject({ success: true, data: { commands: [
      { name: "summarize", description: "Summarize text", source: "prompt", group: "utility" }] } });
    expect(await instance.command("prompt", { message: "/skill:review check the statistics" }))
      .toMatchObject({ success: false, code: "unknown_skill" });
  });

  it.each([undefined, "Custom scientific instructions."])("sends current skill metadata to the model with base prompt %j", async (systemPrompt) => {
    let skillRoot = "";
    async function writeSkill(name: string, description: string, extra = "") {
      await mkdir(join(skillRoot, name), { recursive: true });
      await writeFile(join(skillRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nPrivate skill body.`);
    }
    const { instance, parts } = await runtime(async (cwd) => {
      skillRoot = join(cwd, ".pi", "skills");
      await writeSkill("review", "Review evidence");
      await writeSkill("manual", "Explicit invocation only", "disable-model-invocation: true\n");
    }, { systemPrompt });
    // Keep the real Harness generation path; replace only the provider transport.
    const requests: string[] = [];
    vi.spyOn(parts.models, "streamSimple").mockImplementation((model, request) => {
      const system = normalizeContext(request).messages.find((message) => message.role === "system");
      requests.push(system?.role === "system" ? getSystemMessageText(system) : "");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "OK" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    });
    async function nextPrompt(names: string[]) {
      const count = requests.length;
      expect(await instance.command("prompt", { message: "Inspect the evidence." })).toMatchObject({ success: true });
      await vi.waitFor(async () => {
        expect(requests).toHaveLength(count + 1);
        expect(await instance.command("get_state", {})).toMatchObject({ success: true, data: { busy: false } });
      });
      const prompt = requests.at(-1)!;
      const base = systemPrompt ?? "You are a helpful scientific research assistant.";
      expect(prompt.startsWith(base)).toBe(true);
      expect(prompt).not.toContain("Explicit invocation only");
      expect(prompt).not.toContain("Private skill body.");
      if (names.length) {
        expect(prompt.match(/<available_skills>/g)).toHaveLength(1);
        for (const name of names) {
          expect(prompt).toContain(`<name>${name}</name>`);
          expect(prompt).toContain(join(skillRoot, name, "SKILL.md"));
        }
      } else expect(prompt).toBe(base);
      return prompt;
    }
    expect(await nextPrompt(["review"])).toContain("Review evidence");
    for (const policy of [{ mode: "none" }, { mode: "allowlist", skills: ["manual"] },
      { mode: "denylist", skills: ["review"] }]) {
      expect(await instance.command("set_skill_policy", { policy })).toMatchObject({ success: true });
      await nextPrompt([]);
    }
    expect(await instance.command("set_skill_policy", { policy: { mode: "allowlist", skills: ["review", "added"] } })).toMatchObject({ success: true });
    await nextPrompt(["review"]);
    await writeSkill("review", "Updated evidence protocol");
    await writeSkill("added", "Newly discovered skill");
    expect(await instance.command("refresh_skills", {})).toMatchObject({ success: true });
    const refreshed = await nextPrompt(["review", "added"]);
    expect(refreshed).toContain("Updated evidence protocol");
    expect(refreshed).not.toContain("Review evidence");
    await rm(join(skillRoot, "review"), { recursive: true });
    expect(await instance.command("refresh_skills", {})).toMatchObject({ success: true });
    expect(await nextPrompt(["added"])).not.toContain("<name>review</name>");
    vi.spyOn(parts.harness, "setResources").mockRejectedValueOnce(new Error("resource update failed"));
    expect(await instance.command("set_skill_policy", { policy: { mode: "none" } })).toMatchObject({ success: false });
    expect(await instance.command("get_skills", {})).toMatchObject({ data: { policy: { mode: "allowlist", skills: ["review", "added"] } } });
    await nextPrompt(["added"]);
    await writeSkill("added", "Uncommitted description");
    vi.spyOn(parts.harness, "setResources").mockRejectedValueOnce(new Error("refresh failed"));
    expect(await instance.command("refresh_skills", {})).toMatchObject({ success: false });
    expect(await instance.command("get_skills", {})).toMatchObject({ data: { skills: expect.arrayContaining([
      expect.objectContaining({ name: "added", description: "Newly discovered skill" }),
    ]) } });
    expect(await nextPrompt(["added"])).toContain("Newly discovered skill");
    expect(await instance.command("set_skill_policy", { policy: { mode: "inherit" } })).toMatchObject({ success: true });
    await nextPrompt(["added"]);
  }, 20_000);

  it("derives Bash resource grants from current skills after policy changes and refresh", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const { instance, parts } = await runtime(async (cwd) => {
      await mkdir(join(cwd, ".pi/skills/review"), { recursive: true });
      await writeFile(join(cwd, ".pi/skills/review/SKILL.md"), "---\nname: review\ndescription: Review evidence\n---\nRun helper.py");
      await writeFile(join(cwd, ".pi/skills/loose.md"), "---\nname: loose\ndescription: A standalone skill\n---\nInstructions only.");
    });
    const cwd = parts.executionEnv.cwd;
    const privateRoot = resolve(await mkdtemp(join(tmpdir(), "skill-grants-service-"))); roots.push(privateRoot);
    vi.stubEnv("PI_SCIENCE_HOME", privateRoot);
    const sandbox = await import("../../sandbox/process.js");
    const prepare = vi.spyOn(sandbox, "prepareSandbox").mockRejectedValue(new Error("stop before spawn"));
    const bash = (await parts.harness.getTools(context)).find((tool) => tool.name === "bash")!;
    async function policyForCall(id: string) {
      await expect(bash.execute(id, { command: "true" }, () => {}, { env: parts.executionEnv },
        { operationId: "skill-resources", invocationId: id, turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} }, context)).rejects.toThrow("stop before spawn");
      return prepare.mock.calls.at(-1)![0];
    }
    const review = join(cwd, ".pi/skills/review");
    const initial = await policyForCall("initial");
    expect(initial.readPaths).toContain(review);
    expect(initial.readPaths).not.toContain(join(cwd, ".pi/skills")); // Loose .md files do not authorize a shared parent directory.
    expect(initial.writeDenyPaths).toContain(review);
    expect(await instance.command("set_skill_policy", { policy: { mode: "none" } })).toMatchObject({ success: true });
    const disabled = await policyForCall("disabled");
    expect(disabled.readPaths).not.toContain(review);
    expect(disabled.id).not.toBe(initial.id);
    expect(await instance.command("set_skill_policy", { policy: { mode: "inherit" } })).toMatchObject({ success: true });
    expect((await policyForCall("reenabled")).readPaths).toContain(review);
    const added = join(cwd, ".pi/skills/added"); await mkdir(added);
    await writeFile(join(added, "SKILL.md"), "---\nname: added\ndescription: Newly added helper\n---\nRun helper.sh");
    await rm(join(review, "SKILL.md"));
    expect(await instance.command("refresh_skills", {})).toMatchObject({ success: true });
    const refreshed = await policyForCall("refreshed");
    expect(refreshed.readPaths).toContain(added);
    expect(refreshed.readPaths).not.toContain(review);
  }, 20_000);

  it("does not give ordinary bash processes model, server, or inherited credentials", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host");
    vi.stubEnv("PR115_PARENT_SECRET", "parent-test-secret");
    const { parts } = await runtime();
    const bash = (await parts.harness.getTools(context)).find((tool) => tool.name === "bash")!;
    const script = "console.log(JSON.stringify({model:!!process.env.OPENAI_API_KEY,server:!!process.env.PI_SCIENCE_INTERNAL_TOKEN,parent:!!process.env.PR115_PARENT_SECRET,path:!!process.env.PATH}))";
    const command = `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script}'`;
    const result = await bash.execute("environment-test", { command }, () => undefined,
      { env: parts.executionEnv }, { operationId: "environment-operation", invocationId: "environment-test", turnId: "environment-turn", getMemo: async () => undefined, setMemo: async () => {} }, context);
    const text = result.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("");
    expect(JSON.parse(text.trim())).toEqual({ model: false, server: false, parent: false, path: true });
  });
});

it("persists initial approval before MCP discovery and removes it when initialization fails", async () => {
  const cwd = resolve(await mkdtemp(join(tmpdir(), "initial-approval-"))); roots.push(cwd);
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "private"));
  const { readSessionApproval, sessionApprovalPath } = await import("../../sandbox/session-approval.js");
  const { listWorkspaceSessions } = await import("../workspace-session-identity.js");
  const { JsonlSessionRepo, NodeExecutionEnv } = await import("@earendil-works/pi-agent-core/node");
  let id = "";
  vi.spyOn(AgentMcpTools, "open").mockImplementation(async (_cwd, _bridge, _environment, _legacy, _tools, _restricted, _authorize, sessionId) => {
    id = sessionId!;
    expect(await readSessionApproval(cwd, id)).toEqual({ mode: "auto", revision: 1 });
    throw new Error("MCP initialization failed");
  });
  await expect(SessionRuntime.open({ cwd, sessionsRoot: join(cwd, ".pi-science/agent-sessions"),
    model: { provider: "openai", modelId: "gpt-4.1-mini" }, initialApproval: { mode: "auto" },
  }, () => {}, () => {})).rejects.toThrow("MCP initialization failed");
  expect(id).not.toBe("");
  await expect(readFile(await sessionApprovalPath(cwd, id))).rejects.toMatchObject({ code: "ENOENT" });
  const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd, shellEnv: {} }), sessionsRoot: join(cwd, ".pi-science/agent-sessions") });
  try { expect(await listWorkspaceSessions(repo, cwd)).toEqual([]); } finally { await repo.close(context); }
});

it("blocks prompts and bypass-lane follow-ups until the committed revision releases its barrier", async () => {
  const { instance } = await runtime(async (cwd) => { vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "private")); });
  expect(await instance.command("begin_approval_change", { revision: 0 })).toMatchObject({ success: true });
  expect(await instance.command("follow_up", { message: "queued" })).toMatchObject({ code: "session_busy" });
  expect(await instance.command("steer", { message: "steer" })).toMatchObject({ code: "session_busy" });
  expect(await instance.command("prompt", { message: "new" })).toMatchObject({ code: "session_busy" });
  const { saveSessionApproval } = await import("../../sandbox/session-approval.js");
  const cwd = (instance as unknown as { metadata: { cwd: string } }).metadata.cwd;
  await saveSessionApproval(cwd, instance.sessionId, "auto", 0);
  expect(await instance.command("end_approval_change", { revision: 0 })).toMatchObject({ success: false });
  expect(await instance.command("follow_up", { message: "blocked" })).toMatchObject({ code: "session_busy" });
  expect(await instance.command("end_approval_change", { revision: 1 })).toMatchObject({ success: true });
  expect((instance as unknown as { approvalBarrier: boolean }).approvalBarrier).toBe(false);
});
