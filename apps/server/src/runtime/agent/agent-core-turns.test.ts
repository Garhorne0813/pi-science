import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import { NodeSessionService } from "../node/node-session-service.js";
import { SessionRepository } from "../node/session-repository.js";
import { PiManager } from "../pi/pi-manager.js";
import type { AgentCoreSessionService } from "./agent-core-session-service.js";
import { turnArtifactRepository } from "../artifacts/turn-artifact-repository.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function response(stream: ServerResponse, tools = false): void {
  stream.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "local-response", object: "chat.completion.chunk", created: 1, model: "lab" };
  const delta = tools ? { role: "assistant", tool_calls: [{ index: 0, id: "write-result", type: "function",
    function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "instant result\n" }) } }] }
    : { role: "assistant", content: "Done" };
  stream.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  stream.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  stream.end("data: [DONE]\n\n");
}

async function fixture(mode: "write" | "hold-first" = "write") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-core-turns-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi-science"));
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, ".test-settings"));
  vi.stubEnv("PI_SCIENCE_AGENT_RUNTIME", "agent-core");
  vi.stubEnv("PI_SCIENCE_EVENT_WATCHDOG_MS", "100");
  const requests: Array<{ messages: Array<{ role: string }> }> = [];
  const server = createServer(async (request, stream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof requests[number];
    requests.push(body);
    if (mode === "hold-first" && requests.length === 1) return;
    response(stream, mode === "write" && !body.messages.some((message) => message.role === "tool"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const resources = new ModelResourceService();
  const provider = await resources.createProvider({ name: "Local Lab", adapter: "openai-compatible", catalog_mode: "manual", auth_kind: "api_key", enabled: true });
  const credential = await resources.credentials.put({ kind: "api_key", backend: "managed", secret: "local-test-key" });
  const endpoint = await resources.createEndpoint({ name: "Local test", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, protocol: "openai", credential_ref: credential.id, enabled: true, data_egress: "local" });
  await resources.createBinding({ provider_id: provider.id, endpoint_id: endpoint.id, enabled: true, priority: 1 });
  await resources.updateModel(provider.id, "lab", { enabled: true, capabilities: { reasoning: false, context_window: 128000 } });
  const events: Record<string, unknown>[] = [];
  const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
  const publish = hub.publish.bind(hub);
  vi.spyOn(hub, "publish").mockImplementation(async (...args) => { events.push(args[2]); await publish(...args); });
  const review = { run: vi.fn().mockResolvedValue({}) };
  const service = new NodeSessionService(hub, new PiManager(), new SessionRepository(), { environment: async () => ({}) }, review);
  cleanup.push(() => service.shutdownAll());
  const created = await service.create({ cwd, config: { model: `${provider.id}/lab`, thinking: "off", skills: [], extensions: [] } });
  if (!("id" in created)) throw new Error(created.error);
  const core = (service as unknown as { agentCore: AgentCoreSessionService }).agentCore;
  return { cwd, id: created.id, service, core, events, review, requests };
}

describe("agent-core product turns", () => {
  it("captures a fast tool write and publishes final stats and one automatic review", async () => {
    const { cwd, id, service, core, events, review } = await fixture();
    expect(await service.command(id, cwd, "prompt", { message: "write a result", client_message_id: "write-once" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.artifacts")).toBe(true), { timeout: 15000 });
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("instant result\n");
    const records = await turnArtifactRepository.forSession(cwd, id);
    expect(records).toHaveLength(1);
    expect(records[0]?.artifacts).toEqual([expect.objectContaining({ path: "result.txt" })]);
    await vi.waitFor(() => expect(review.run).toHaveBeenCalledOnce(), { timeout: 15000 });
    expect(await service.stats(id, cwd)).toMatchObject({ stats: { userMessages: 1, toolCalls: 1, toolResults: 1, tokens: { total: 220 } } });
    const runtime = core.liveRuntime(cwd)!;
    runtime.emit("event", { type: "operation.started", runId: records[0]!.turn_id, turnId: records[0]!.turn_id, recovery: true });
    runtime.emit("event", { type: "operation.settled", runId: records[0]!.turn_id, status: "completed" });
    await vi.waitFor(() => expect(events.filter((event) => event.type === "session.stats").length).toBeGreaterThan(4));
    expect(await turnArtifactRepository.forSession(cwd, id)).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.artifacts")).toHaveLength(1);
    await vi.waitFor(() => expect(review.run).toHaveBeenCalledOnce(), { timeout: 15000 });
  }, 45000);

  it("automatically reopens a killed worker and resumes one durable prompt", async () => {
    const { cwd, id, service, core, events, requests } = await fixture("hold-first");
    const original = core.liveRuntime(cwd)!;
    expect(await service.command(id, cwd, "prompt", { message: "continue after failure", client_message_id: "recover-once" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 15000 });
    original.child.kill("SIGKILL");
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 15000 });
    await vi.waitFor(() => expect(events.some((event) => event.type === "session.stats")).toBe(true), { timeout: 15000 });
    expect(core.liveRuntime(cwd)).not.toBe(original);
    expect(events.some((event) => event.code === "worker_recovering")).toBe(true);
    const history = await new SessionRepository().messages(cwd, id);
    expect(history.filter((message) => message.client_message_id === "recover-once")).toHaveLength(1);
    await vi.waitFor(async () => expect(await service.state(id, cwd)).toMatchObject({ is_streaming: false }), { timeout: 15000 });
  }, 45000);

  it("detects a lost settled event and completes the persisted product lifecycle after reopening", async () => {
    const { cwd, id, service, core, events, review } = await fixture();
    const original = core.liveRuntime(cwd)!;
    const emit = original.emit.bind(original);
    vi.spyOn(original, "emit").mockImplementation((type, ...args) => type === "event" && args[0]?.type === "operation.settled" ? false : emit(type, ...args));
    expect(await service.command(id, cwd, "prompt", { message: "write and recover", client_message_id: "lost-settle" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn.artifacts")).toBe(true), { timeout: 15000 });
    expect(core.liveRuntime(cwd)).not.toBe(original);
    expect(await turnArtifactRepository.forSession(cwd, id)).toHaveLength(1);
    await vi.waitFor(() => expect(review.run).toHaveBeenCalledOnce(), { timeout: 15000 });
    expect((await new SessionRepository().messages(cwd, id)).filter((message) => message.client_message_id === "lost-settle")).toHaveLength(1);
  }, 45000);
  it("keeps cancellation and timing in cold history when stopping before the model replies", async () => {
    const { cwd, id, service, core, requests } = await fixture("hold-first");
    expect(await service.command(id, cwd, "prompt", { message: "stop before reply", client_message_id: "stop-pending" })).toMatchObject({ success: true });
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 15000 });
    expect(await service.command(id, cwd, "abort", {})).toMatchObject({ success: true });
    const repository = new SessionRepository();
    await vi.waitFor(async () => expect((await repository.messages(cwd, id))[0]).toMatchObject({ turnStatus: "aborted" }), { timeout: 15000 });
    await core.shutdownAll();
    const page = await repository.messagesPage(cwd, id, { limit: 1 });
    expect(page.messages[0]).toMatchObject({ turnStatus: "aborted", turnStartedAt: expect.any(String), turnEndedAt: expect.any(String) });
    expect(Date.parse(page.messages[0]!.turnEndedAt!) - Date.parse(page.messages[0]!.turnStartedAt!)).toBeGreaterThanOrEqual(0);
  }, 45000);

});
