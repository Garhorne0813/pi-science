import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationEventHub } from "../events/conversation-event-hub.js";
import type { SseEventRecord } from "../events/event-store.js";
import { captureCitationSources } from "./source-capture.js";
import { verifyCitationSources } from "./source-verify.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-science-citation-pipeline-"));
  roots.push(root);
  await mkdir(join(root, ".pi-science"), { recursive: true });
  return root;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

/** Publish a read through the real hub so the fixture is the shape production
 *  persists, not a hand-written one. */
async function readThroughHub(cwd: string, sessionId: string, path: string, text: string): Promise<SseEventRecord[]> {
  const records: SseEventRecord[] = [];
  const store = {
    append: async (_cwd: string, _sessionId: string, event: SseEventRecord) => { records.push(event); },
    readAfter: async () => records,
  };
  const hub = new ConversationEventHub(store);
  const runtime = new EventEmitter();
  hub.bind(cwd, runtime, { activeSessionId: () => sessionId, onBusy: () => undefined, onExit: () => undefined });
  runtime.emit("event", { type: "tool.started", toolCallId: "call-1", toolName: "read", args: { path } });
  runtime.emit("event", { type: "tool.completed", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text }] }, isError: false });
  await hub.flush();
  await eventually(() => records.some((record) => record.data.includes(`"type":"tool.completed"`)));
  return records;
}

function publishedTurnId(records: SseEventRecord[]): string {
  for (const record of records) {
    const data = JSON.parse(record.data) as { turnId?: unknown };
    if (typeof data.turnId === "string") return data.turnId;
  }
  throw new Error("the projection published no turn id");
}

async function capturedRead(cwd: string, path: string, text: string) {
  const records = await readThroughHub(cwd, "s1", path, text);
  return captureCitationSources(records, { turnIds: [publishedTurnId(records)] });
}

/** One fetch that caches a page and one that pages the same cache, each in its
 *  own turn, both published through the real hub. */
async function fetchThroughHub(cwd: string): Promise<SseEventRecord[]> {
  const records: SseEventRecord[] = [];
  const store = {
    append: async (_cwd: string, _sessionId: string, event: SseEventRecord) => { records.push(event); },
    readAfter: async () => records,
  };
  const hub = new ConversationEventHub(store);
  const runtime = new EventEmitter();
  hub.bind(cwd, runtime, { activeSessionId: () => "s1", onBusy: () => undefined, onExit: () => undefined });
  const page = (slice: string, offset: number) => ({ content: [{ type: "text", text: `${slice}\n\nResponse ID: deepseek_1` }],
    details: { provider: "deepseek", responseId: "deepseek_1", offset, totalChars: 80 } });
  const call = (callId: string, args: Record<string, unknown>, slice: string, offset: number) => {
    runtime.emit("event", { type: "tool.started", toolCallId: callId, toolName: "web_fetch", args });
    const result = page(slice, offset);
    runtime.emit("event", { type: "tool.completed", toolCallId: callId, toolName: "web_fetch", result, details: result.details, isError: false });
  };
  runtime.emit("event", { type: "operation.started", turnId: "turn-1", runId: "run-1" });
  call("call-1", { url: "https://example.org/paper" }, "First slice", 0);
  runtime.emit("event", { type: "operation.started", turnId: "turn-2", runId: "run-2" });
  call("call-2", { responseId: "deepseek_1", offset: 20, limit: 20 }, "Second slice", 20);
  await hub.flush();
  await eventually(() => records.filter((record) => record.data.includes(`"type":"tool.completed"`)).length === 2);
  return records;
}

describe("citation evidence from the published event stream", () => {
  it("verifies the file a read actually returned", async () => {
    const cwd = await workspace();
    const body = "# Results\n\nAccuracy improved by 4%.\n";
    await writeFile(join(cwd, "report.md"), body, "utf8");
    const captured = await capturedRead(cwd, "report.md", body);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ kind: "file", identity: "report.md", excerpt: body.trim(), locator: { kind: "lines", startLine: 1, endLine: 3 } });
    const [verified] = await verifyCitationSources(cwd, captured);
    expect(verified).toMatchObject({ status: "verified", excerpt: body.trim(), statusDetail: null });
  });

  it("reports the same capture as changed once the file moves on", async () => {
    const cwd = await workspace();
    const captured = await capturedRead(cwd, "report.md", "Accuracy improved by 4%.\n");
    await writeFile(join(cwd, "report.md"), "Accuracy improved by 9%.\n", "utf8");
    const [verified] = await verifyCitationSources(cwd, captured);
    expect(verified).toMatchObject({ status: "changed", excerpt: "Accuracy improved by 4%." });
    expect(verified?.statusDetail).toMatch(/read at answer time/);
  });

  it("registers a page a response id addresses under the url the first fetch used", async () => {
    const cwd = await workspace();
    const captured = captureCitationSources(await fetchThroughHub(cwd), { turnIds: ["turn-2"] });
    expect(captured).toMatchObject([{ kind: "web", identity: "https://example.org/paper", excerpt: "Second slice", locator: { kind: "chars", start: 20, end: 40 }, evidence: { callId: "call-2", turnId: "turn-2" } }]);
    expect(captureCitationSources(await fetchThroughHub(cwd), { turnIds: ["turn-9"] })).toEqual([]);
  });

  it("verifies a paginated read whose output carries the tool's continuation note", async () => {
    const cwd = await workspace();
    const lines = Array.from({ length: 40 }, (_value, index) => `row ${index + 1}`);
    await writeFile(join(cwd, "table.csv"), lines.join("\n"), "utf8");
    const captured = await capturedRead(cwd, "table.csv", lines.join("\n"));
    expect(captured[0]?.excerpt).toBe(lines.join("\n"));
    const [verified] = await verifyCitationSources(cwd, captured);
    expect(verified).toMatchObject({ status: "verified" });
  });
});
