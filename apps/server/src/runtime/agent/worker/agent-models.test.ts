import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../../../model-resources/credential-store.js";
import { ModelResourceRepository } from "../../../model-resources/model-resource-repository.js";
import { agentModelCatalog, agentModels } from "./agent-models.js";
import { ModelConfigService } from "../../../model-config/model-config-service.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createServer } from "node:http";
import { SessionRuntime } from "./session-runtime.js";
import { AgentSessionRepository } from "../agent-session-repository.js";

const previousHome = process.env.PI_SCIENCE_HOME;
const roots: string[] = [];
afterEach(async () => {
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent-core model credentials", () => {
  it("uses canonical model routes, endpoint-specific credentials, aliases and thinking capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-core-custom-"));
    roots.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const requests: Array<{ url: string; authorization?: string; model: string }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
      requests.push({ url: request.url!, authorization: request.headers.authorization, model: body.model });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const service = new ModelConfigService();
      const provider = { id: "native-lab" };
      for (const [index, name] of ["one", "two"].entries()) {
        await service.createProvider(index, index === 0 ? provider.id : "native-second", { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/${name}/v1`, models: [{ id: name, reasoning: true, contextWindow: 8192, thinkingLevelMap: { off: "off", high: "high", minimal: null, low: null, medium: null, xhigh: null, max: null } }] }, { source: "managed", secret: `secret-${name}` });
      }
      const models = agentModels({ model_context_window_override: { model: `${provider.id}/one`, context_window: 4096 } });
      for (const name of ["one", "two"]) {
        const model = models.getModel(name === "one" ? provider.id : "native-second", name)!;
        expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
        expect(model.contextWindow).toBe(name === "one" ? 4096 : 8192);
        const result = await models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] });
        expect(result.stopReason).toBe("stop");
        expect(result.usage.totalTokens).toBe(102);
      }
      expect(requests).toEqual(["one", "two"].map((name) => ({ url: `/${name}/v1/chat/completions`, authorization: `Bearer secret-${name}`, model: name })));
      expect(JSON.stringify(await agentModelCatalog(models))).not.toContain("secret-");
      const events: Array<{ type: string }> = [];
      const runtime = await SessionRuntime.open({ cwd: root, sessionsRoot: join(root, ".pi-science", "agent-sessions"),
        model: { provider: provider.id, modelId: "one" }, thinking: "high",
        settings: { compaction_enabled: false, compaction_threshold_percent: 80,
          model_context_window_override: { model: `${provider.id}/one`, context_window: 4096 } },
      }, (event) => events.push(event), (error) => { throw error; });
      try {
        await runtime.command("activate", {});
        expect(await runtime.command("get_available_thinking_levels", {})).toMatchObject({ success: true, data: { levels: ["off", "high"] } });
        expect(await runtime.command("configure", { provider: "native-second", modelId: "two", level: "medium" }))
          .toMatchObject({ success: false, code: "invalid_thinking" });
        expect(await runtime.command("get_state", {})).toMatchObject({ data: { context_tokens: null, context_window: 4096,
          compaction: { enabled: false, reserveTokens: 820 }, compaction_threshold_percent: 80, thinkingLevel: "high" } });
        expect(await runtime.command("prompt", { message: "hello", client_message_id: "custom-model-run" })).toMatchObject({ success: true });
        await vi.waitFor(() => expect(events.some((event) => event.type === "operation.settled")).toBe(true));
        expect(await runtime.command("get_state", {})).toMatchObject({ data: { context_tokens: 102, context_window: 4096, context_percent: 102 / 4096 * 100 } });
        expect(await new AgentSessionRepository().runtimeState(root, runtime.sessionId)).toMatchObject({ context_tokens: 102,
          context_window: 4096, compaction_enabled: false, compaction_threshold_percent: 80 });
        expect(await runtime.command("compact", {})).toMatchObject({ success: true });
        await vi.waitFor(() => expect(events.some((event) => event.type === "compaction.end" || event.type === "compaction.error")).toBe(true));
        expect(events.some((event) => event.type === "compaction.start")).toBe(true);
      } finally { await runtime.close(); }
      await service.replace(service.readSync().revision, { providers: {} });
      expect((await agentModelCatalog()).some((model) => model.provider === provider.id)).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("resolves a Settings-managed DeepSeek key for the built-in provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-core-models-"));
    roots.push(root);
    process.env.PI_SCIENCE_HOME = root;
    await new CredentialStore().putRaw("deepseek-test", { kind: "api_key", backend: "managed" }, "test-secret");
    await new ModelConfigService().update(0, (snapshot) => { snapshot.config.providers.deepseek = {}; snapshot.credential_refs.deepseek = "deepseek-test"; });
    const models = agentModels();
    expect(models.getModel("deepseek", "deepseek-v4-pro")).toBeDefined();
    expect(models.getModel("deepseek", "deepseek-v4-flash")).toBeUndefined();
    expect(models.getModel("deepseek", "deepseek-flash")).toBeDefined();
    expect(await models.getAuth("deepseek")).toMatchObject({ auth: { apiKey: "test-secret" } });
    const catalog = await agentModelCatalog();
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "deepseek", id: "deepseek-v4-pro" })]));
    expect(catalog).not.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "deepseek", id: "deepseek-v4-flash" })]));
  });
});
