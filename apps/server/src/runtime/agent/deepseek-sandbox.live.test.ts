import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { readJson, configPath, writeJsonAtomic } from "../../storage/persistence.js";
import { executionRepository } from "../executions/execution-repository.js";
import { workspacePolicy } from "../sandbox/policy.js";
import { prepareSandbox, launcherPath } from "../sandbox/process.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai";

it("serializes DeepSeek high effort before networking", async () => {
  const base = builtinModels().getModel("deepseek", "deepseek-flash");
  if (!base) throw new Error("deepseek-flash is missing from the installed model catalog");
  let payload: Record<string, unknown> | undefined, networkAttempted = false;
  const model = { ...base, api: "openai-completions" as const, provider: "live-test-route", baseUrl: "http://127.0.0.1:1/deepseek.com/v1", reasoning: true,
    thinkingLevelMap: { off: null, high: "high" } };
  const result = await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Synthetic sandbox test", timestamp: 1 }] }), {
    apiKey: "not-a-real-credential", reasoning: "high", maxRetries: 0,
    onPayload(value) { payload = value as Record<string, unknown>; throw new Error("Local payload validation complete"); },
    fetch: async () => { networkAttempted = true; throw new Error("Networking forbidden in payload preflight"); },
  }).result();
  expect(payload).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "high" });
  expect(result.errorMessage).toContain("Local payload validation complete");
  expect(networkAttempted).toBe(false);
});

interface RequestEvidence {
  model: string;
  reasoning_effort: string;
  thinking_enabled: boolean;
  status?: number;
  response_models: string[];
  reasoning_chunks: number;
  usage?: Record<string, unknown>;
}

/** Audits real requests and forwards their unchanged bodies to one fixed
 * official HTTPS endpoint. No generated responses, credentials or CoT are logged. */
async function officialGateway(key: string, requests: RequestEvidence[]) {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) throw new Error("Live request exceeds audit limit");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString("utf8"));
      if (request.method !== "POST" || request.url !== "/deepseek.com/v1/chat/completions" || request.headers.authorization !== `Bearer ${key}` || requests.length >= 8) {
        response.writeHead(403).end("Live test request limit or routing violation"); return;
      }
      const evidence: RequestEvidence = { model: body.model, reasoning_effort: body.reasoning_effort,
        thinking_enabled: body.thinking?.type === "enabled", response_models: [], reasoning_chunks: 0 };
      requests.push(evidence);
      if (evidence.model !== "deepseek-flash" || evidence.reasoning_effort !== "high" || !evidence.thinking_enabled) {
        response.writeHead(400).end("Live test requires deepseek-flash with enabled thinking and high effort"); return;
      }
      const upstream = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: bytes, signal: AbortSignal.timeout(90_000),
      });
      evidence.status = upstream.status;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
      if (!upstream.ok) { await upstream.body?.cancel(); response.end(`Official DeepSeek HTTP ${upstream.status}`); return; }
      if (!upstream.body) throw new Error("Official DeepSeek response has no body");
      const decoder = new TextDecoder(); let pending = "";
      for await (const chunk of upstream.body) {
        response.write(chunk); pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          const data = JSON.parse(line.slice(5));
          if (typeof data.model === "string" && !evidence.response_models.includes(data.model)) evidence.response_models.push(data.model);
          if (data.choices?.some((choice: { delta?: { reasoning_content?: string } }) => choice.delta?.reasoning_content)) evidence.reasoning_chunks++;
          if (data.usage) evidence.usage = data.usage;
        }
      }
      response.end();
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end("Official DeepSeek transport or audit failure"); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: (server.address() as { port: number }).port };
}

// Opt-in only: calls the official endpoint and incurs real provider usage.
it.skipIf(process.env.PI_SCIENCE_DEEPSEEK_LIVE_TEST !== "1")("runs real DeepSeek main/child tool calls through the required sandbox", async () => {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the live test");
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("The required sandbox live test needs Linux or macOS");
  const root = resolve("../../.runtime/live-tests"); await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, "deepseek-"));
  const savedHome = process.env.PI_SCIENCE_HOME; const savedMode = process.env.PI_SCIENCE_EXECUTION_MODE;
  process.env.PI_SCIENCE_HOME = join(cwd, ".settings"); process.env.PI_SCIENCE_EXECUTION_MODE = "required";
  const manager = new AgentRuntimeManager();
  const requests: RequestEvidence[] = [];
  let gateway: Awaited<ReturnType<typeof officialGateway>> | undefined;
  let passed = false;
  const startedAt = new Date().toISOString();
  let executionEvidence: unknown[] = [];
  try {
    // Fail before paying for model requests if the OS sandbox cannot start.
    const prepared = await prepareSandbox(await workspacePolicy(cwd), ["/bin/bash", "-c", "test ! -r /etc/passwd"], [], 5);
    try {
      await new Promise<void>((resolveStart, reject) => {
        const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
        let stderr = ""; child.stderr!.on("data", (chunk) => stderr = (stderr + chunk).slice(-4096));
        child.once("error", reject); child.once("close", (code) => code === 0 ? resolveStart() : reject(new Error(`Sandbox preflight failed: ${stderr}`)));
      });
    } finally { await prepared.cleanup(); }
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await writeFile(join(cwd, ".pi-science/protected"), "LIVE_TEST_PROTECTED");
    await mkdir(join(cwd, ".pi/agents"), { recursive: true });
    await writeFile(join(cwd, ".pi/agents/runner.md"), "---\nname: runner\ndescription: Live sandbox command runner\ntools: [bash]\n---\nRun the requested Bash command once, then report its actual output. Do not delegate.");
    const resources = new ModelResourceService();
    gateway = await officialGateway(process.env.DEEPSEEK_API_KEY, requests);
    const provider = await resources.createProvider({ name: "DeepSeek live", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
    const credential = await resources.credentials.put({ kind: "api_key", backend: "environment", environment_variable: "DEEPSEEK_API_KEY" });
    // The path retains DeepSeek's compatibility discriminator in pi-ai while
    // the local gateway audits and forwards exclusively to the official API.
    const endpoint = await resources.createEndpoint({ name: "DeepSeek official audited", base_url: `http://127.0.0.1:${gateway.port}/deepseek.com/v1`, protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "remote" });
    await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
    const modelId = "deepseek-flash";
    await resources.updateModel(provider.id, modelId, { enabled: true, capabilities: { reasoning: true, thinking_levels: ["off", "high"], context_window: 128000, max_output_tokens: 8192 } });
    await writeJsonAtomic(configPath("config.json"), { ...await readJson(configPath("config.json"), {}), model: `${provider.id}/${modelId}`, thinking: "high" });
    // Worker environments deliberately exclude ambient provider secrets. Pass this
    // environment-backed credential explicitly, as the production session adapter does.
    const runtime = await openHiddenTask(manager, "deepseek-live", { cwd, sessionsRoot: join(cwd, ".pi-science/agent-sessions"), model: { provider: provider.id, modelId }, env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }, thinking: "high", allowedTools: ["bash", "subagent"], skillPolicy: { mode: "none" } }, "live-test-owner");
    expect(await runtime.sendCommand("get_state")).toMatchObject({ success: true, data: { thinkingLevel: "high" } });
    const command = "set -e; test -z \"$DEEPSEEK_API_KEY\"; test ! -r .pi-science/protected; printf main-isolated > main.txt; echo main-isolated";
    const childCommand = command.replaceAll("main", "child");
    const output = await runHiddenPrompt(runtime, `Execute exactly these steps, without extra tool calls: (1) Call bash with command ${JSON.stringify(command)}. (2) Call subagent with agent='runner' and task asking it to call bash exactly once with command ${JSON.stringify(childCommand)}. (3) Summarize the actual results. Stop if any step fails; do not retry.`, "live-once", Date.now() + 300_000);
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
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const request of requests) expect(request).toMatchObject({ model: modelId, reasoning_effort: "high", thinking_enabled: true, status: 200 });
    expect(requests.some((request) => request.reasoning_chunks > 0)).toBe(true);
    executionEvidence = executions.map((record) => ({ status: record.status, runtime: record.runtime, artifact_count: record.artifacts.length }));
    passed = true;
  } finally {
    await manager.shutdownAll();
    if (gateway) { gateway.server.closeAllConnections(); await new Promise<void>((resolveClose) => gateway!.server.close(() => resolveClose())); }
    const report = join(root, `deepseek-flash-high-${startedAt.replaceAll(/[:.]/g, "-")}.json`);
    await writeFile(report, JSON.stringify({ started_at: startedAt, finished_at: new Date().toISOString(), platform: process.platform,
      model: "deepseek-flash", reasoning_effort: "high", passed, official_endpoint: "https://api.deepseek.com/v1/chat/completions", requests, executions: executionEvidence }, null, 2), { mode: 0o600 });
    console.log(`DeepSeek live evidence: ${report}`);
    if (savedHome === undefined) delete process.env.PI_SCIENCE_HOME; else process.env.PI_SCIENCE_HOME = savedHome;
    if (savedMode === undefined) delete process.env.PI_SCIENCE_EXECUTION_MODE; else process.env.PI_SCIENCE_EXECUTION_MODE = savedMode;
    await rm(cwd, { recursive: true, force: true });
  }
}, 360_000);
