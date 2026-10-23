import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ProviderConfig } from "@pi-science/contracts";
import { ModelConfigService } from "./model-config-service.js";
import { ModelRegistryService } from "./model-registry-service.js";
import { ModelResourceService } from "../model-resources/model-resource-service.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pi-keyless-http-")); vi.stubEnv("PI_SCIENCE_HOME", root); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each([["openai-completions", true], ["openai-responses", true], ["anthropic-messages", true], ["anthropic-messages", false]] as const)("keeps discovery and real %s streaming auth consistent (versioned base: %s)", async (api, versionedBase) => {
  const requests: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "test", context_length: 200000, max_output_tokens: 32768 }] })); return; }
    for await (const _chunk of request) { /* consume request before streaming */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    if (api === "anthropic-messages") {
      event("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "test", stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      event("message_stop", {});
    } else if (api === "openai-responses") {
      event("response.created", { response: { id: "r", model: "test", status: "in_progress", output: [] } });
      event("response.output_item.added", { output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "in_progress", content: [] } });
      event("response.content_part.added", { item_id: "m", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { item_id: "m", output_index: 0, content_index: 0, delta: "ok" });
      event("response.completed", { response: { id: "r", model: "test", status: "completed", output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    } else {
      response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.write("data: [DONE]\n\n");
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}${versionedBase ? "/v1" : ""}`;
    const service = new ModelConfigService(), resources = new ModelResourceService();
    for (const source of ["keyless", "managed"] as const) {
      const discovered = await resources.testProviderConfiguration({ base_url: baseUrl, protocol: api === "anthropic-messages" ? "anthropic" : "openai", auth: source === "keyless" ? { kind: "none" } : { kind: "api_key", secret: "explicit-test-key" } });
      expect(discovered.models[0]?.capabilities).toMatchObject({ context_window: 200000, max_output_tokens: 32768 });
      const config: ProviderConfig = { api, baseUrl, models: [{ id: "test", contextWindow: 200000, maxTokens: 32768, discoveredFields: ["contextWindow", "maxTokens"] }], modelOverrides: { test: { contextWindow: 128000 } } };
      await service.createProvider(service.readSync().revision, source, config, source === "keyless" ? { source } : { source, secret: "explicit-test-key" });
      const registry = new ModelRegistryService(service).compile(), model = registry.getModel(source, "test")!;
      expect(model.contextWindow).toBe(128000);
      const stream = registry.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] });
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
      const pair = requests.slice(-2);
      expect(pair[0]?.url).toBe(api === "anthropic-messages" ? "/v1/models?limit=100" : "/v1/models");
      expect(pair[1]?.url).toBe(api === "anthropic-messages" ? "/v1/messages?beta=true" : api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
      for (const request of pair) {
        if (source === "keyless") { expect(request.headers.authorization).toBeUndefined(); expect(request.headers["x-api-key"]).toBeUndefined(); expect(JSON.stringify(request.headers)).not.toContain("unused"); }
        else if (api === "anthropic-messages") expect(request.headers["x-api-key"]).toBe("explicit-test-key");
        else expect(request.headers.authorization).toBe("Bearer explicit-test-key");
      }
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}, 15000);
