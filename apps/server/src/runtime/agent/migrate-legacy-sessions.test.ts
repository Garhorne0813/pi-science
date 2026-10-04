import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { migrateLegacySessions } from "./migrate-legacy-sessions.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import { AgentSessionRegistry } from "./agent-session-registry.js";
import { NodeSessionService } from "../node/node-session-service.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))); });
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "core-conversion-"))); roots.push(cwd);
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "home"));
  const directory = join(cwd, ".pi-science", "sessions", "nested"); await mkdir(directory, { recursive: true });
  const source = join(directory, "old.jsonl");
  const original = [
    { type: "session", version: 3, id: "old", cwd, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "model_change", id: "model", parentId: null, provider: "openai", modelId: "gpt-4.1-mini", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "off", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "user", parentId: "thinking", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "prior" }], timestamp: 1767225601000 } },
    { type: "message", id: "tool", parentId: "user", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolName: "todo", toolCallId: "call", content: [{ type: "text", text: "tasks" }], details: { tasks: [{ title: "kept" }] }, timestamp: 1767225602000 } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(source, original); return { cwd, source, original };
}
it("converts fully offline to v4, preserves details/model and records translated IDs and originals, and is idempotent", async () => {
  const { cwd, source, original } = await fixture();
  expect(await migrateLegacySessions(cwd, true)).toEqual([{ source, sessionId: "old", status: "would-convert" }]);
  expect(await new AgentSessionRegistry().get(cwd, "old")).toBeUndefined();
  const converted = await migrateLegacySessions(cwd);
  expect(converted).toEqual([expect.objectContaining({ source, sessionId: "old", status: "converted", entryIds: { user: expect.any(String), tool: expect.any(String) } })]);
  const repo = new AgentSessionRepository(); const target = await repo.findPath(cwd, "old"); expect(target).toBeTruthy();
  expect(JSON.parse((await readFile(target!, "utf8")).split("\n")[0]!)).toMatchObject({ v: 4, id: "old" });
  expect(await repo.messages(cwd, "old")).toEqual([expect.objectContaining({ id: converted[0]!.entryIds!.user }), expect.objectContaining({ id: converted[0]!.entryIds!.tool, details: { tasks: [{ title: "kept" }] } })]);
  expect(await repo.configuration(cwd, "old")).toMatchObject({ model: { provider: "openai", modelId: "gpt-4.1-mini" } });
  expect(await migrateLegacySessions(cwd)).toEqual([{ source, sessionId: "old", status: "already-converted", entryIds: converted[0]!.entryIds }]);
  expect(await readFile(source, "utf8")).toBe(original);
});
it("rejects damaged input without granting ownership and continues the batch", async () => {
  const { cwd, source } = await fixture(); const corrupt = join(source, "..", "bad.jsonl");
  await writeFile(corrupt, '{"type":"session","version":3,"id":"bad","cwd":'+JSON.stringify(cwd)+'}\nnot-json\n');
  const result = await migrateLegacySessions(cwd);
  expect(result).toContainEqual(expect.objectContaining({ source: corrupt, status: "failed" }));
  expect(result).toContainEqual(expect.objectContaining({ sessionId: "old", status: "converted" }));
  expect(await new AgentSessionRegistry().get(cwd, "bad")).toBeUndefined();
});
it("does not resurrect a deleted imported session from its original", async () => {
  const { cwd, source } = await fixture(); await migrateLegacySessions(cwd);
  const target = await new AgentSessionRepository().findPath(cwd, "old");
  await new AgentSessionRegistry().markDeleted(cwd, "old", target!);
  expect(await migrateLegacySessions(cwd)).toEqual([{ source, sessionId: "old", status: "deleted" }]);
});
it("automatically converts a cold legacy session without a runtime switch or API key", async () => {
  const { cwd } = await fixture(); vi.stubEnv("PI_SCIENCE_AGENT_RUNTIME", "orbit"); vi.stubEnv("PI_CLI_PATH", "/missing/orbit");
  const service = new NodeSessionService();
  try {
    expect(await service.state("old", cwd)).toMatchObject({ id: "old", model: "openai/gpt-4.1-mini", is_streaming: false });
    expect(service.processCount).toBe(0);
    expect(await new AgentSessionRegistry().get(cwd, "old")).toMatchObject({ backend: "agent-core" });
  } finally { await service.shutdownAll(); }
});

it("preserves legacy string bodies and custom context messages during offline conversion", async () => {
  const { cwd, source, original } = await fixture();
  const custom = { type: "custom_message", id: "context", parentId: "tool", timestamp: "2026-01-01T00:00:03.000Z", customType: "context", content: "retained context", display: false };
  await writeFile(source, original + JSON.stringify(custom) + "\n");
  const result = await migrateLegacySessions(cwd);
  expect(result[0]).toMatchObject({ status: "converted", entryIds: { context: expect.any(String) } });
  expect(await new AgentSessionRepository().messages(cwd, "old")).toContainEqual(expect.objectContaining({ id: result[0]!.entryIds!.context, role: "custom", content: [{ type: "text", text: "retained context" }] }));
});

it("converts a legacy workspace alias using its filesystem identity", async () => {
  const { cwd, source, original } = await fixture();
  const alias = join(cwd, "workspace-alias");
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const rows = original.trim().split("\n").map((row) => JSON.parse(row));
  rows[0].cwd = alias;
  const input = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(source, input);
  expect(await migrateLegacySessions(cwd, true)).toEqual([{ source, sessionId: "old", status: "would-convert" }]);
  expect((await migrateLegacySessions(cwd))[0]).toMatchObject({ status: "converted" });
  expect(await new AgentSessionRepository().messages(cwd, "old")).toHaveLength(2);
  expect(await readFile(source, "utf8")).toBe(input);
});

it("waits for an in-flight conversion before exposing a history snapshot", async () => {
  const { cwd } = await fixture();
  const service = new NodeSessionService();
  const upgrade = AgentSessionRepository.prototype.upgradeLegacy;
  let signal!: () => void;
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(AgentSessionRepository.prototype, "upgradeLegacy").mockImplementation(async function (this: AgentSessionRepository, ...args) {
    signal(); await gate; return upgrade.apply(this, args);
  });
  try {
    const first = service.prepareHistory(cwd, "old");
    await entered;
    let done = false;
    const second = service.prepareHistory(cwd, "old").then((result) => { done = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    release();
    expect(await first).toMatchObject({ success: true });
    expect(await second).toMatchObject({ success: true });
    expect(service.processCount).toBe(0);
    const repository = new AgentSessionRepository();
    const ids = await repository.migrationEntryIds(cwd, "old");
    expect((await repository.messages(cwd, "old")).map((message) => message.id)).toEqual([ids.user, ids.tool]);
  } finally { release(); spy.mockRestore(); await service.shutdownAll(); }
});
