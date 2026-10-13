import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app/app.js";
import { createServerModules } from "../../app/server-modules.js";
import type { ServerConfig } from "../../config/config.js";
import type { KernelExecuteOptions, KernelResult, NodeKernelManager } from "../../runtime/kernel/node-kernel-manager.js";

const STALLED_CLIENT_CEILING_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const BURST_CHUNK = "x".repeat(16 * 1024);
const BURST_EVENTS = 2048;
const SEQUENCE_EVENTS = 200;
const HUGE_EVENT_BYTES = 2 * 1024 * 1024;
const HUGE_RESULT_TEXT = "HEAD" + "y".repeat(2 * 1024 * 1024) + "TAIL";
const MAX_SINGLE_WRITE_BYTES = 16 * 1024;

const openApps: Array<{ close(): Promise<unknown> }> = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["http://127.0.0.1:5173"],
    maxBodyBytes: 10 * 1024 * 1024,
    upstreamTimeoutMs: 30_000,
    nodeSessions: false,
    nodeSse: false,
    nodeFiles: false,
    nodePiManager: false,
    logLevel: "silent",
    ...overrides,
  };
}

function kernelManager(handlers: Record<string, (options: KernelExecuteOptions) => Promise<KernelResult>>): NodeKernelManager {
  return {
    async execute(options: KernelExecuteOptions) {
      const handler = handlers[options.code];
      if (!handler) throw new Error(`unexpected kernel code: ${options.code}`);
      return await handler(options);
    },
    async shutdownAll() {},
  } as unknown as NodeKernelManager;
}

function okResult(overrides: Partial<KernelResult> = {}): KernelResult {
  return { ok: true, stdout: "", stderr: "", result: null, error: null, interrupted: false, mime: {}, outputs: [], ...overrides };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function streamingKernel(completed: string[]): NodeKernelManager {
  return kernelManager({
    "burst-output": async (options) => {
      for (let index = 0; index < BURST_EVENTS; index += 1) options.onEvent?.({ type: "stream", stream: "stdout", text: BURST_CHUNK });
      completed.push(options.code);
      return okResult({ stdout: "burst complete\n" });
    },
    "sequence-output": async (options) => {
      for (let index = 0; index < SEQUENCE_EVENTS; index += 1) options.onEvent?.({ type: "stream", stream: "stdout", text: `line ${index}\n` });
      completed.push(options.code);
      return okResult({ stdout: Array.from({ length: SEQUENCE_EVENTS }, (_value, index) => `line ${index}`).join("\n") + "\n" });
    },
    "slow-output": async (options) => {
      for (let index = 0; index < 6; index += 1) {
        options.onEvent?.({ type: "stream", stream: "stdout", text: `chunk ${index}\n` });
        await sleep(40);
      }
      completed.push(options.code);
      return okResult({ stdout: "cell finished\n" });
    },
    "huge-result-output": async () => okResult({ stdout: HUGE_RESULT_TEXT }),
    "huge-event-output": async (options) => {
      options.onEvent?.({ type: "stream", stream: "stdout", text: "z".repeat(HUGE_EVENT_BYTES) });
      completed.push(options.code);
      return okResult({ stdout: "huge event delivered\n" });
    },
  });
}

async function startWorkspace(): Promise<string> {
  const workspace = join(tmpdir(), `pi-science-kernel-stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(workspace, ".pi-science"), { recursive: true });
  workspaces.push(workspace);
  return workspace;
}

function startApp(kernels: NodeKernelManager): FastifyInstance {
  const app = buildApp(config(), { ...createServerModules(config()), kernels });
  openApps.push(app);
  return app;
}

async function listen(app: FastifyInstance): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  return (app.server.address() as AddressInfo).port;
}

interface StreamedResponse {
  request: ClientRequest;
  response: IncomingMessage;
  frames: Array<Record<string, unknown>>;
  bytes: number;
}

function openStream(port: number, workspace: string, payload: Record<string, unknown>): Promise<StreamedResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/api/kernels/execute-stream?cwd=${encodeURIComponent(workspace)}`,
      headers: { "content-type": "application/json" },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const streamed: StreamedResponse = { request, response, frames: [], bytes: 0 };
      response.once("error", () => undefined);
      resolve(streamed);
    });
    request.end(JSON.stringify(payload));
  });
}

/** Attach the reader only now, so a test can leave the socket unread first and starve the server's write queue. */
function collect(streamed: StreamedResponse): Promise<void> {
  let buffer = "";
  return new Promise((resolve) => {
    streamed.response.on("data", (chunk: Buffer) => {
      streamed.bytes += chunk.length;
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) streamed.frames.push(JSON.parse(line) as Record<string, unknown>);
    });
    streamed.response.once("end", () => {
      if (buffer.trim()) streamed.frames.push(JSON.parse(buffer) as Record<string, unknown>);
      resolve();
    });
    streamed.response.once("close", () => resolve());
  });
}

function terminalFrame(streamed: StreamedResponse): Record<string, unknown> {
  const terminal = streamed.frames.at(-1);
  expect(terminal, "stream must end with a terminal result frame").toBeDefined();
  expect(terminal?.type).toBe("result");
  return terminal!;
}

async function readExecution(app: FastifyInstance, workspace: string, executionId: string): Promise<Record<string, unknown>> {
  const response = await app.inject({ method: "GET", url: `/api/executions/${executionId}?cwd=${encodeURIComponent(workspace)}` });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

async function waitForTerminalExecution(app: FastifyInstance, workspace: string, executionId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const record = await readExecution(app, workspace, executionId);
    if (record.status !== "running" && record.status !== "pending") return record;
    await sleep(25);
  }
  throw new Error(`execution ${executionId} never reached a terminal status`);
}

describe("kernel NDJSON stream backpressure", () => {
  it("bounds a stalled client's live stream and reports the dropped bytes", async () => {
    const completed: string[] = [];
    const app = startApp(streamingKernel(completed));
    const workspace = await startWorkspace();
    const port = await listen(app);

    const baseline = process.memoryUsage();
    const streamed = await openStream(port, workspace, { language: "python", code: "burst-output", notebook_id: "backpressure" });
    await sleep(400);
    const stalled = process.memoryUsage();
    const finished = collect(streamed);
    await finished;
    // eslint-disable-next-line no-console
    console.log("backpressure repro", JSON.stringify({
      produced_bytes: BURST_CHUNK.length * BURST_EVENTS,
      received_bytes: streamed.bytes,
      rss_delta_bytes: stalled.rss - baseline.rss,
      external_delta_bytes: stalled.external - baseline.external,
    }));

    expect(streamed.bytes, "live stream bytes must stay under the documented bound").toBeLessThan(STALLED_CLIENT_CEILING_BYTES);
    expect(stalled.rss - baseline.rss, "server memory must stay under the documented bound").toBeLessThan(STALLED_CLIENT_CEILING_BYTES * 8);
    const retained = streamed.frames.filter((frame) => frame.type === "stream").map((frame) => String(frame.text)).join("");
    expect(BURST_CHUNK.repeat(BURST_EVENTS).startsWith(retained), "a truncated live stream keeps the first bytes and drops the tail").toBe(true);
    const frameTypes = streamed.frames.map((frame) => frame.type);
    expect(frameTypes[0]).toBe("started");
    expect(frameTypes.filter((type) => type === "stream_truncated"), "exactly one truncation notice").toHaveLength(1);
    expect(frameTypes.indexOf("stream_truncated")).toBeLessThan(frameTypes.length - 1);
    expect(frameTypes.slice(1, frameTypes.indexOf("stream_truncated")).every((type) => type === "stream"), "the notice follows the retained prefix").toBe(true);
    const notice = streamed.frames.find((frame) => frame.type === "stream_truncated") as { bytes_dropped: number; frames_dropped: number };
    expect(notice.bytes_dropped).toBeGreaterThan(0);
    expect(notice.frames_dropped).toBeGreaterThan(0);
    const terminal = terminalFrame(streamed);
    expect(terminal).toMatchObject({ ok: true });
    expect(terminal.stream_transport).toMatchObject({ truncated: true, client_disconnected: false });
    expect((terminal.stream_transport as { bytes_dropped: number }).bytes_dropped).toBeGreaterThan(0);
    expect(completed).toEqual(["burst-output"]);

    const evidence = await readExecution(app, workspace, String(terminal.execution_id));
    expect(evidence).toMatchObject({ status: "succeeded", usage: { stream_transport: { truncated: true } } });
    expect((evidence.usage as { stream_transport: unknown }).stream_transport, "evidence and the wire must carry one snapshot").toEqual(terminal.stream_transport);
    expect((terminal.stream_transport as { pending_bytes_high_water: number }).pending_bytes_high_water, "queued bytes must stay under the documented limit").toBeLessThanOrEqual(512 * 1024);
  }, 60_000);

  it("caps an oversized terminal frame and flags the truncation", async () => {
    const completed: string[] = [];
    const app = startApp(streamingKernel(completed));
    const workspace = await startWorkspace();
    const port = await listen(app);

    const streamed = await openStream(port, workspace, { language: "python", code: "huge-result-output", notebook_id: "huge-result" });
    const finished = collect(streamed);
    await finished;

    const terminal = terminalFrame(streamed);
    expect(terminal.stream_transport).toMatchObject({ truncated: true });
    const stdout = String(terminal.stdout);
    expect(stdout.startsWith("HEAD"), "the head of the output survives").toBe(true);
    expect(stdout.endsWith("TAIL"), "the tail of the output survives").toBe(true);
    expect(stdout).toContain("… [truncated] …");
    expect(Buffer.byteLength(JSON.stringify(terminal) + "\n"), "the serialized frame must fit the documented byte bound").toBeLessThanOrEqual(MAX_FRAME_BYTES);
  }, 60_000);

  it("bounds every socket write when one stream event carries a huge payload", async () => {
    const completed: string[] = [];
    const writeSizes: number[] = [];
    const app = startApp(streamingKernel(completed));
    const workspace = await startWorkspace();
    app.addHook("onRequest", async (_request, reply) => {
      const raw = reply.raw;
      const original = raw.write.bind(raw) as (...args: unknown[]) => boolean;
      raw.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") writeSizes.push(Buffer.byteLength(chunk));
        else if (Buffer.isBuffer(chunk)) writeSizes.push(chunk.length);
        return original(chunk, ...rest);
      }) as typeof raw.write;
    });
    const port = await listen(app);

    const streamed = await openStream(port, workspace, { language: "python", code: "huge-event-output", notebook_id: "huge-event" });
    const finished = collect(streamed);
    await finished;

    expect(writeSizes.length).toBeGreaterThan(0);
    expect(Math.max(...writeSizes), "no single socket write may exceed the documented bound").toBeLessThanOrEqual(MAX_SINGLE_WRITE_BYTES);
    const retained = streamed.frames.filter((frame) => frame.type === "stream").map((frame) => String(frame.text)).join("");
    expect("z".repeat(HUGE_EVENT_BYTES).startsWith(retained)).toBe(true);
    expect(streamed.frames.filter((frame) => frame.type === "stream_truncated")).toHaveLength(1);
    const terminal = terminalFrame(streamed);
    expect(terminal.stream_transport).toMatchObject({ truncated: true });
    expect(completed).toEqual(["huge-event-output"]);
  }, 60_000);

  it("preserves live stream order for a client that keeps up", async () => {
    const completed: string[] = [];
    const app = startApp(streamingKernel(completed));
    const workspace = await startWorkspace();
    const port = await listen(app);

    const streamed = await openStream(port, workspace, { language: "python", code: "sequence-output", notebook_id: "ordering" });
    const finished = collect(streamed);
    await finished;

    const chunks = streamed.frames.filter((frame) => frame.type === "stream").map((frame) => String(frame.text));
    expect(chunks.join("")).toBe(Array.from({ length: SEQUENCE_EVENTS }, (_value, index) => `line ${index}\n`).join(""));
    const terminal = terminalFrame(streamed);
    expect(terminal.stream_transport).toMatchObject({ truncated: false, client_disconnected: false });
    expect((terminal.stream_transport as { bytes_dropped: number }).bytes_dropped).toBe(0);
  }, 60_000);

  it("finishes the cell and records a terminal status when the client disconnects", async () => {
    const completed: string[] = [];
    const app = startApp(streamingKernel(completed));
    const workspace = await startWorkspace();
    const port = await listen(app);

    const streamed = await openStream(port, workspace, { language: "python", code: "slow-output", notebook_id: "disconnect" });
    const finished = collect(streamed);
    await sleep(120);
    const executionId = String(streamed.frames.find((frame) => frame.type === "started")?.execution_id);
    expect(executionId).not.toBe("undefined");
    streamed.request.destroy();
    await finished;
    await sleep(300);

    const evidence = await waitForTerminalExecution(app, workspace, executionId);
    expect(evidence).toMatchObject({
      status: "succeeded",
      usage: { stream_transport: { client_disconnected: true } },
      result: { ok: true, stdout_preview: "cell finished\n" },
    });
    expect(completed).toEqual(["slow-output"]);

    const afterDisconnect = await app.inject({ method: "POST", url: `/api/kernels/execute?cwd=${encodeURIComponent(workspace)}`, payload: { language: "python", code: "sequence-output", notebook_id: "disconnect" } });
    expect(afterDisconnect.json()).toMatchObject({ ok: true });
  }, 60_000);
});
