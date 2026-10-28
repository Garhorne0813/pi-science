import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, link, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EnvHttpProxyAgent, fetch } from "undici";
import { expect, it } from "vitest";
import { ModelConfigService } from "../../model-config/model-config-service.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";

interface RequestEvidence {
  model: string; reasoning_effort: string; thinking_enabled: boolean;
  status?: number; response_models: string[]; reasoning_chunks: number; usage?: unknown;
}
interface Message {
  role: string; toolName?: string; isError?: boolean; details?: unknown;
  content: Array<{ type: string; text?: string }>;
}

/** Fixed-destination audit gateway: unchanged real requests/responses, no mock
 * completions. Only request flags, response metadata and token counts survive. */
async function gateway(key: string, evidence: RequestEvidence[]) {
  const dispatcher = new EnvHttpProxyAgent();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("request_limit");
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString("utf8"));
      if (request.method !== "POST" || request.url !== "/deepseek.com/v1/chat/completions" || request.headers.authorization !== `Bearer ${key}` || evidence.length >= 12) {
        response.writeHead(403).end("audit_route_or_budget_denied"); return;
      }
      const item: RequestEvidence = { model: body.model, reasoning_effort: body.reasoning_effort,
        thinking_enabled: body.thinking?.type === "enabled", response_models: [], reasoning_chunks: 0 };
      evidence.push(item);
      if (item.model !== "deepseek-flash" || item.reasoning_effort !== "high" || !item.thinking_enabled) {
        response.writeHead(400).end("required_model_or_effort_missing"); return;
      }
      const upstream = await fetch("https://api.deepseek.com/v1/chat/completions", {
        dispatcher, method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: bytes, signal: AbortSignal.timeout(90_000),
      });
      item.status = upstream.status;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
      if (!upstream.ok) { await upstream.body?.cancel(); response.end(`Official DeepSeek HTTP ${upstream.status}`); return; }
      if (!upstream.body) throw new Error("missing_body");
      const decoder = new TextDecoder(); let pending = "";
      for await (const chunk of upstream.body) {
        response.write(chunk); pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n"); pending = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          const event = JSON.parse(line.slice(5));
          if (typeof event.model === "string" && !item.response_models.includes(event.model)) item.response_models.push(event.model);
          if (event.choices?.some((choice: { delta?: { reasoning_content?: string } }) => choice.delta?.reasoning_content)) item.reasoning_chunks++;
          if (event.usage) item.usage = event.usage;
        }
      }
      response.end();
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end("official_transport_or_audit_failure"); });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { port: (server.address() as { port: number }).port, async close() {
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await dispatcher.close();
  } };
}

// Paid, explicit opt-in. No credentials are stored in fixtures or reports.
it.skipIf(process.env.PI_SCIENCE_DISCOVERY_LIVE_TEST !== "1")("validates discovery with real DeepSeek Flash high-effort tool calls", async () => {
  if (!process.env.DEEPSEEK_API_KEY || process.platform !== "linux") throw new Error("Linux and DEEPSEEK_API_KEY are required");
  const output = resolve("../../work/live-tests"); await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, "discovery-")); const cwd = join(root, "workspace");
  const previousHome = process.env.PI_SCIENCE_HOME; const previousMode = process.env.PI_SCIENCE_EXECUTION_MODE;
  process.env.PI_SCIENCE_HOME = join(root, "private-state"); process.env.PI_SCIENCE_EXECUTION_MODE = "required";
  const manager = new AgentRuntimeManager(); const requests: RequestEvidence[] = [];
  let audit: Awaited<ReturnType<typeof gateway>> | undefined; let passed = false;
  const scenarios: Array<Record<string, unknown>> = []; const started = new Date().toISOString();
  const put = async (path: string, content: string) => { await mkdir(join(cwd, path, ".."), { recursive: true }); await writeFile(join(cwd, path), content); };
  try {
    await mkdir(cwd);
    await put("data/raw/sample.csv", "temperature,humidity\n20,40\n22,42\n");
    await put("data/results/summary.tsv", "mean\tvalue\ntemperature\t21\n");
    await put("data/ignored.csv", "IGNORED_DISCOVERY_MARKER\n");
    await put("analysis/prepare.py", "import pandas as pd\nframe = pd.read_csv('data/raw/sample.csv')\nprint(frame.describe())\n");
    await put("analysis/report.R", "data <- read.table('data/results/summary.tsv', header=TRUE)\n");
    await put("README.md", "Synthetic temperature/humidity study; start with analysis/prepare.py.\n");
    await put(".gitignore", "data/ignored.csv\n");
    for (const path of [".env", "holdout/labels.json", "node_modules/private.txt", "credentials.json"]) await put(path, "PRIVATE_DISCOVERY_MARKER");
    const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "PRIVATE_DISCOVERY_MARKER");
    await symlink(outside, join(cwd, "alias")); await link(join(outside, "secret.txt"), join(cwd, "hard.txt"));
    const publicPaths = ["data/raw/sample.csv", "data/results/summary.tsv", "analysis/prepare.py", "analysis/report.R", "README.md"];
    const digest = async () => Promise.all(publicPaths.map(async (path) => [path, createHash("sha256").update(await readFile(join(cwd, path))).digest("hex")]));
    const before = await digest();
    audit = await gateway(process.env.DEEPSEEK_API_KEY, requests);
    const providerId = "discovery-live-deepseek";
    // Use the current canonical models.json path, not retired resource routing.
    await new ModelConfigService().createProvider(0, providerId, {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${audit.port}/deepseek.com/v1`,
      models: [{ id: "deepseek-flash", reasoning: true, contextWindow: 128000, maxTokens: 8192,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null } }],
    }, { source: "environment", environment_variable: "DEEPSEEK_API_KEY" });
    for (const scenario of ["exploration", "parallel_denials", "sensitive_file_denial"] as const) {
      const runtime = await openHiddenTask(manager, `discovery-live-${scenario}`, { cwd, sessionsRoot: join(cwd, ".pi-science/agent-sessions"),
        model: { provider: providerId, modelId: "deepseek-flash" }, thinking: "high", allowedTools: ["ls", "glob", "grep", "read"],
        env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }, skillPolicy: { mode: "none" } }, "live-discovery-owner");
      expect(await runtime.sendCommand("get_state")).toMatchObject({ success: true, data: { thinkingLevel: "high", activeTools: ["ls", "glob", "grep", "read"] } });
      const prompt = scenario === "exploration"
        ? 'Synthetic file-discovery acceptance. Actually call each native tool exactly once in this order, never simulate results: ls({path:"."}), glob({pattern:"**/*.csv",path:"data"}), grep({pattern:"read_csv|read.table",path:"analysis",glob:"**/*.{py,R}"}), then read({path:"analysis/prepare.py"}). After receiving the actual results, explain which CSV files are visible, which scripts load the data and where to begin analysis. Do not invoke other tools or read other files; do not retry errors. Reply concisely in Chinese.'
        : scenario === "parallel_denials"
          ? 'Synthetic negative-permission and concurrency acceptance. Issue exactly these three native tool calls together in ONE parallel tool-call batch, once each: ls({path:"holdout"}), glob({pattern:"**/*",path:"../outside"}), grep({pattern:".",path:".env"}). The tools allow at most two concurrent searches, so one should return resource_limit and the others controlled permission/input errors. Report the actual codes and stop. Do not retry or use read/other paths to bypass the errors. Reply concisely in Chinese.'
          : 'Synthetic sensitive-file denial acceptance. Invoke ONLY grep({pattern:".",path:".env"}) exactly once and report its actual error code. Do not retry, infer contents, or use read/another path to bypass the rejection. Reply concisely in Chinese.';
      console.log(`Starting real DeepSeek discovery scenario: ${scenario}`);
      const answer = await runHiddenPrompt(runtime, prompt, `live-${scenario}`, Date.now() + 240_000);
      const history = await runtime.sendCommand("get_messages"); expect(history.success).toBe(true);
      const messages = (history.data as { messages: Array<{ message: Message }> }).messages.map((entry) => entry.message);
      const results = messages.filter((message) => message.role === "toolResult");
      const names = results.map((message) => message.toolName);
      const serialized = JSON.stringify(results);
      expect(serialized).not.toContain("PRIVATE_DISCOVERY_MARKER"); expect(serialized).not.toContain("IGNORED_DISCOVERY_MARKER");
      expect(serialized).not.toContain(cwd); expect(answer).not.toContain("PRIVATE_DISCOVERY_MARKER");
      if (scenario === "exploration") {
        expect(names).toEqual(["ls", "glob", "grep", "read"]);
        expect(results.every((message) => !message.isError)).toBe(true);
        expect(serialized).not.toMatch(/holdout|credentials\.json|node_modules|alias|hard\.txt/);
        const result = (name: string) => JSON.parse(results.find((message) => message.toolName === name)!.content.map((part) => part.text ?? "").join(""));
        expect(result("glob")).toMatchObject({ files: ["data/raw/sample.csv"], truncated: false });
        expect(result("grep").matches).toEqual([
          { path: "analysis/prepare.py", line: 2, column: 12, text: "frame = pd.read_csv('data/raw/sample.csv')" },
          { path: "analysis/report.R", line: 1, column: 9, text: "data <- read.table('data/results/summary.tsv', header=TRUE)" },
        ]);
        expect(answer).toContain("data/raw/sample.csv"); expect(answer).toContain("analysis/prepare.py");
      } else if (scenario === "parallel_denials") {
        expect([...names].sort()).toEqual(["glob", "grep", "ls"]);
        expect(results.every((message) => message.isError)).toBe(true);
        const codes = results.map((message) => message.content.map((part) => part.text ?? "").join(""));
        expect(codes.filter((code) => code === "resource_limit")).toHaveLength(1);
        for (const [index, message] of results.entries()) expect([message.toolName === "glob" ? "invalid_input" : "access_denied", "resource_limit"]).toContain(codes[index]);
      } else {
        expect(names).toEqual(["grep"]);
        expect(results[0]!.isError).toBe(true);
        expect(results[0]!.content.map((part) => part.text ?? "").join("")).toBe("access_denied");
      }
      scenarios.push({ scenario, passed: true, tools: names, answer, results });
      console.log(`Passed real DeepSeek discovery scenario: ${scenario}`);
    }
    expect(await digest()).toEqual(before);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const request of requests) expect(request).toMatchObject({ model: "deepseek-flash", reasoning_effort: "high", thinking_enabled: true, status: 200 });
    expect(requests.some((request) => request.reasoning_chunks > 0)).toBe(true);
    passed = true;
  } finally {
    await manager.shutdownAll(); if (audit) await audit.close();
    const report = join(output, `discovery-deepseek-flash-high-${started.replaceAll(/[:.]/g, "-")}.json`);
    await writeFile(report, JSON.stringify({ started_at: started, finished_at: new Date().toISOString(), model: "deepseek-flash", reasoning_effort: "high", passed,
      official_endpoint: "https://api.deepseek.com/v1/chat/completions", requests, scenarios }, null, 2), { mode: 0o600 });
    console.log(`Discovery live evidence: ${report}`);
    if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME; else process.env.PI_SCIENCE_HOME = previousHome;
    if (previousMode === undefined) delete process.env.PI_SCIENCE_EXECUTION_MODE; else process.env.PI_SCIENCE_EXECUTION_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  }
}, 540_000);
