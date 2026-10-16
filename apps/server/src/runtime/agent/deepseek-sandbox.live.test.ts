import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { readJson, configPath, writeJsonAtomic } from "../../storage/persistence.js";
import { executionRepository } from "../executions/execution-repository.js";
import { workspacePolicy } from "../sandbox/policy.js";
import { processSettings } from "../sandbox/settings.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";

// Opt-in only: calls the official endpoint and incurs real provider usage.
it.skipIf(process.env.PI_SCIENCE_DEEPSEEK_LIVE_TEST !== "1")("runs real DeepSeek main/child tool calls through the required sandbox", async () => {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the live test");
  if (process.platform !== "linux") throw new Error("The required sandbox live test needs Linux");
  const root = resolve("../../.runtime/live-tests"); await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, "deepseek-"));
  const savedHome = process.env.PI_SCIENCE_HOME; const savedMode = process.env.PI_SCIENCE_EXECUTION_MODE;
  process.env.PI_SCIENCE_HOME = join(cwd, ".settings"); process.env.PI_SCIENCE_EXECUTION_MODE = "required";
  const manager = new AgentRuntimeManager();
  try {
    // Fail before paying for model requests if the OS sandbox cannot start.
    await processSettings(await workspacePolicy(cwd), []);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(join(cwd, ".pi-science/protected"), "LIVE_TEST_PROTECTED");
    await mkdir(join(cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(cwd, ".pi/agents/runner.md"), "---\nname: runner\ndescription: Live sandbox command runner\ntools: [bash]\n---\nRun the requested Bash command once, then report its actual output. Do not delegate.");
    const resources = new ModelResourceService();
    const provider = await resources.createProvider({ name: "DeepSeek live", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
    const credential = await resources.credentials.put({ kind: "api_key", backend: "environment", environment_variable: "DEEPSEEK_API_KEY" });
    const endpoint = await resources.createEndpoint({ name: "DeepSeek official", base_url: "https://api.deepseek.com/v1", protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "remote" });
    await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const modelId = "deepseek-flash";
    await resources.updateModel(provider.id, modelId, { enabled: true, capabilities: { reasoning: false, context_window: 128000 } });
    await writeJsonAtomic(configPath("config.json"), { ...await readJson(configPath("config.json"), {}), model: `${provider.id}/${modelId}`, thinking: "off" });
    const runtime = await openHiddenTask(manager, "deepseek-live", { cwd, sessionsRoot: join(cwd, ".pi-science/agent-sessions"), model: { provider: provider.id, modelId }, thinking: "off", allowedTools: ["bash", "subagent"], skillPolicy: { mode: "none" } }, "live-test-owner");
    const command = "set -e; test -z \"$DEEPSEEK_API_KEY\"; test ! -r .pi-science/protected; printf main-isolated > main.txt; echo main-isolated";
    const childCommand = command.replaceAll("main", "child");
    const output = await runHiddenPrompt(runtime, `Execute exactly these steps, without extra tool calls: (1) Call bash with command ${JSON.stringify(command)}. (2) Call subagent with agent='runner' and task asking it to call bash exactly once with command ${JSON.stringify(childCommand)}. (3) Summarize the actual results. Stop if any step fails; do not retry.`, "live-once", Date.now() + 180_000);
    expect(output.trim()).not.toBe("");
    expect(await readFile(join(cwd, "main.txt"), "utf8")).toBe("main-isolated");
    expect(await readFile(join(cwd, "child.txt"), "utf8")).toBe("child-isolated");
    const executions = (await executionRepository.list(cwd)).filter((record) => record.producer === "bash");
    expect(executions).toHaveLength(2);
    for (const record of executions) {
      expect(record.status).toBe("succeeded");
      expect(record.runtime).toMatchObject({ execution_mode: "required", sandbox_policy_id: expect.any(String) });
      expect(record.artifacts.length).toBeGreaterThan(0);
    }
  } finally {
    await manager.shutdownAll();
    if (savedHome === undefined) delete process.env.PI_SCIENCE_HOME; else process.env.PI_SCIENCE_HOME = savedHome;
    if (savedMode === undefined) delete process.env.PI_SCIENCE_EXECUTION_MODE; else process.env.PI_SCIENCE_EXECUTION_MODE = savedMode;
    await rm(cwd, { recursive: true, force: true });
  }
}, 210_000);
