import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionStats } from "@pi-science/contracts";
import { deleteSessionStats, foldSessionFileStats, loadSessionStats, saveSessionStats } from "./session-stats-repository.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const cwd = join(tmpdir(), `pi-science-stats-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  cleanup.push(cwd);
  await mkdir(cwd, { recursive: true });
  return cwd;
}

function sampleStats(): SessionStats {
  return {
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 4,
    toolResults: 4,
    totalMessages: 10,
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    cost: 0.45,
    llmMs: 6000,
    toolMs: 2500,
    ttftMs: 300,
    ttftSteps: 4,
    decodeMs: 5200,
  };
}

beforeEach(() => {
  cleanup.length = 0;
});

describe("session-stats-repository", () => {
  it("round-trips a stats checkpoint through save/load", async () => {
    const cwd = await workspace();
    const stats = sampleStats();
    await saveSessionStats(cwd, "sess-1", stats);
    const loaded = await loadSessionStats(cwd, "sess-1");
    expect(loaded).toEqual(stats);
  });

  it("returns null for a missing checkpoint", async () => {
    const cwd = await workspace();
    expect(await loadSessionStats(cwd, "missing")).toBeNull();
  });

  it("rejects a malformed checkpoint instead of returning it", async () => {
    const cwd = await workspace();
    const dir = join(cwd, ".pi-science", "sessions", "stats");
    await mkdir(dir, { recursive: true });
    // tokens is an object in the real DTO; the old buggy loader checked
    // Array.isArray and would have discarded valid checkpoints.
    await writeFile(join(dir, "bad.json"), JSON.stringify({ userMessages: 1, tokens: { input: 1 } }), "utf8");
    expect(await loadSessionStats(cwd, "bad")).toBeNull();
    await writeFile(join(dir, "valid.json"), JSON.stringify(sampleStats()), "utf8");
    expect(await loadSessionStats(cwd, "valid")).toEqual(sampleStats());
  });

  it("deleteSessionStats removes the checkpoint and subsequent loads return null", async () => {
    const cwd = await workspace();
    await saveSessionStats(cwd, "sess-2", sampleStats());
    await deleteSessionStats(cwd, "sess-2");
    expect(await loadSessionStats(cwd, "sess-2")).toBeNull();
  });

  it("folds a session JSONL into whole-log counters with deduped tool calls and summed usage", async () => {
    const cwd = await workspace();
    const dir = join(cwd, ".pi-science", "sessions");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sess-3.jsonl");
    await writeFile(path, [
      JSON.stringify({ type: "session", id: "sess-3", cwd, timestamp: "2026-08-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "message", id: "a1", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read" }], usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, cost: { total: 0.01 } } } }),
      JSON.stringify({ type: "message", id: "r1", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "message", id: "a2", timestamp: "2026-08-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash" }, { type: "toolCall", id: "t1", name: "read" }], usage: { input: 200, output: 40, cacheRead: 160, cacheWrite: 10 } } }),
      JSON.stringify({ type: "message", id: "r2", timestamp: "2026-08-01T00:00:05.000Z", message: { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "message", id: "a3", timestamp: "2026-08-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "bye" }], usage: { input: 300, output: 60 } } }),
    ].join("\n") + "\n", "utf8");

    const stats = await foldSessionFileStats(path);
    expect(stats.userMessages).toBe(1);
    expect(stats.assistantMessages).toBe(3);
    expect(stats.toolResults).toBe(2);
    expect(stats.toolCalls).toBe(2); // t1 appears twice, deduped; t2 once
    expect(stats.totalMessages).toBe(6);
    expect(stats.tokens).toEqual({ input: 600, output: 120, cacheRead: 240, cacheWrite: 10, total: 970 });
    expect(stats.cost).toBeCloseTo(0.01);
  });

  it("folds a file with no message lines into zeroed counters", async () => {
    const cwd = await workspace();
    const dir = join(cwd, ".pi-science", "sessions");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sess-4.jsonl");
    await writeFile(path, JSON.stringify({ type: "session", id: "sess-4", cwd }) + "\n", "utf8");
    const stats = await foldSessionFileStats(path);
    expect(stats.userMessages).toBe(0);
    expect(stats.toolCalls).toBe(0);
    expect(stats.tokens.total).toBe(0);
  });
});
