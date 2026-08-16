import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduledTask } from "@pi-science/contracts";
import type { PiResult } from "../runtime/pi/pi-process.js";
import { HeadlessAgentExecutor, buildDeltaNote, computeNewSources, digestPrompt, parseDigestResponse, readLatestPreviousManifest, type DigestSource } from "./headless-agent-runner.js";

const cleanup: string[] = [];
let originalHome: string | undefined;
let originalCliPath: string | undefined;

beforeEach(() => {
  originalHome = process.env.PI_SCIENCE_HOME;
  originalCliPath = process.env.PI_CLI_PATH;
  // buildPiProcessOptions returns null without a CLI path and reads settings
  // from the config root; both are isolated per test below.
  process.env.PI_CLI_PATH = "/fake/pi.js";
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
  if (originalCliPath === undefined) delete process.env.PI_CLI_PATH;
  else process.env.PI_CLI_PATH = originalCliPath;
});

class FakeAgentProcess extends EventEmitter {
  readonly commands: Array<{ type: string; params: Record<string, unknown> }> = [];
  constructor(private readonly handlers: Array<(params: Record<string, unknown>, process: FakeAgentProcess) => Promise<PiResult> | PiResult | void>) { super(); }
  async sendCommand(type: string, params: Record<string, unknown> = {}): Promise<PiResult> {
    this.commands.push({ type, params });
    const handler = this.handlers.shift();
    if (!handler) return { success: true };
    return (await handler(params, this)) ?? { success: true };
  }
}

class FakePiManager {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  readonly processes: FakeAgentProcess[] = [];
  constructor(private readonly factory: () => FakeAgentProcess = () => new FakeAgentProcess([])) {}
  async start(key: string): Promise<FakeAgentProcess> {
    this.started.push(key);
    const process = this.factory();
    this.processes.push(process);
    return process;
  }
  async stop(key: string): Promise<void> { this.stopped.push(key); }
}

/** Emits a fake agent turn: streamed text_delta chunks, a message_end with
 *  usage, then agent_settled so the runner's prompt promise resolves. */
function emitTurn(process: FakeAgentProcess, text: string, usage: { input: number; output: number; cost: number }): void {
  setImmediate(() => {
    const half = Math.ceil(text.length / 2);
    process.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(0, half) } });
    process.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(half) } });
    process.emit("event", { type: "message_end", message: { usage: { input: usage.input, output: usage.output, cost: { total: usage.cost } } } });
    process.emit("event", { type: "agent_settled" });
  });
}

const SOURCES: DigestSource[] = [
  { title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", provider: "arxiv" },
  { title: "BERT: Pre-training of Deep Bidirectional Transformers", url: "https://arxiv.org/abs/1810.04805", provider: "arxiv" },
];
const MARKDOWN = "## 综述\n\nTransformer 架构是当前机器学习的主流。\n\n## 来源\n- [Attention](https://arxiv.org/abs/1706.03762) (arxiv)";

function digestJson(markdown: string = MARKDOWN, sources: DigestSource[] = SOURCES): string {
  return JSON.stringify({ markdown, sources });
}

const NOW = new Date("2025-01-06T09:00:00.000Z");
const STAMP = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;
const HHMM = `${String(NOW.getHours()).padStart(2, "0")}${String(NOW.getMinutes()).padStart(2, "0")}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    task_id: "task-0000000000000001",
    schema_version: 1,
    revision: 0,
    name: "daily digest",
    type: "literature_digest",
    enabled: true,
    schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
    executor: { kind: "headless_agent", config: { query: "machine learning", providers: ["arxiv"], instructions: "focus on transformers" } },
    output: { relative_path: "reports/literature" },
    approval: { status: "none", content_hash: "hash", revision: 0, categories: [], terms: [], updated_at: "2025-01-06T00:00:00.000Z" },
    retry: { max_attempts: 2 },
    next_run_at: null,
    last_run_at: null,
    created_at: "2025-01-06T00:00:00.000Z",
    updated_at: "2025-01-06T00:00:00.000Z",
    ...overrides,
  };
}

async function harness(processFactory: () => FakeAgentProcess): Promise<{ cwd: string; manager: FakePiManager; executor: HeadlessAgentExecutor; logs: string[] }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-headless-"));
  cleanup.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true }); // workspace marker
  const home = await mkdtemp(join(tmpdir(), "pi-science-headless-home-"));
  cleanup.push(home);
  process.env.PI_SCIENCE_HOME = home; // isolate config-root writes
  const manager = new FakePiManager(processFactory);
  const logs: string[] = [];
  const executor = new HeadlessAgentExecutor({
    environments: { environment: async () => ({}) },
    manager,
    now: () => NOW,
  });
  return { cwd, manager, executor, logs };
}

const log = (logs: string[]) => async (line: string) => { logs.push(line); };

describe("HeadlessAgentExecutor", () => {
  it("runs a successful digest: prompt, JSON parse, report + manifest write, usage", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }), // get_state
      () => emitTurn(process, digestJson(), { input: 100, output: 40, cost: 0.003 }),
    ]);
    const { cwd, manager, executor, logs } = await harness(() => process);
    const result = await executor.run(task(), "run-1", { cwd, log: log(logs) });

    // Prompt contract.
    expect(process.commands.map((command) => command.type)).toEqual(["get_state", "prompt"]);
    const message = String(process.commands[1]!.params.message);
    expect(message).toContain("http://127.0.0.1:8787/api/literature/search"); // PI_SCIENCE_PORT unset → default
    expect(message).toContain("machine learning");
    expect(message).toContain("arxiv");
    expect(message).toContain("编造");
    expect(message).toContain("严格 JSON");

    // Report + manifest written by the control plane.
    const reportPath = join(cwd, "reports", "literature", `${STAMP}.md`);
    const manifestPath = join(cwd, "reports", "literature", `${STAMP}.manifest.json`);
    expect(result.output_paths).toEqual([`reports/literature/${STAMP}.md`, `reports/literature/${STAMP}.manifest.json`]);
    expect(await readFile(reportPath, "utf8")).toBe(`${MARKDOWN}\n`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest.task_id).toBe("task-0000000000000001");
    expect(manifest.run_id).toBe("run-1");
    expect(manifest.query).toBe("machine learning");
    expect(manifest.providers).toEqual(["arxiv"]);
    expect(manifest.executed_at).toBe(NOW.toISOString());
    expect(manifest.sources).toEqual(SOURCES);
    expect(manifest.dedup_keys).toEqual([...new Set(SOURCES.map((source) => source.url.toLowerCase()))]);
    expect(manifest.output_files).toEqual([{ path: `${STAMP}.md`, sha256: sha256(`${MARKDOWN}\n`) }]);

    // Usage accumulated from message_end events; agent session isolated.
    expect(result.usage).toEqual({ model_tokens: 140, cost_usd: 0.003 });
    await expect(stat(join(cwd, ".pi-science", "scheduled-task-sessions", "run-1"))).resolves.toBeTruthy();
    expect(manager.started).toEqual(["scheduled-task:run-1"]);
    expect(manager.stopped).toEqual(["scheduled-task:run-1"]);
    expect(logs.some((line) => line.includes("wrote"))).toBe(true);
    expect(logs.some((line) => line.includes("machine learning"))).toBe(true);
  });

  it("repairs a non-JSON response once and still accumulates usage from both turns", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }), // get_state
      () => emitTurn(process, "Here you go:\n```json\n{oops", { input: 10, output: 10, cost: 0.001 }),
      () => emitTurn(process, digestJson(), { input: 20, output: 20, cost: 0.002 }),
    ]);
    const { cwd, manager, executor } = await harness(() => process);
    const result = await executor.run(task(), "run-2", { cwd, log: async () => undefined });

    expect(process.commands).toHaveLength(3);
    expect(String(process.commands[2]!.params.message)).toContain("Return ONLY valid JSON");
    expect(result.output_paths[0]).toBe(`reports/literature/${STAMP}.md`);
    expect(result.usage).toEqual({ model_tokens: 60, cost_usd: 0.003 }); // both turns counted
    expect(manager.stopped).toEqual(["scheduled-task:run-2"]);
  });

  it("fails when the repaired response is still not strict JSON", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }), // get_state
      () => emitTurn(process, "not json at all", { input: 1, output: 1, cost: 0 }),
      () => emitTurn(process, "still not json", { input: 1, output: 1, cost: 0 }),
    ]);
    const { cwd, executor } = await harness(() => process);
    await expect(executor.run(task(), "run-3", { cwd, log: async () => undefined })).rejects.toThrow(/invalid JSON after one repair/);
  });

  it("writes a timestamped report when the daily file was modified outside the task", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }),
      () => emitTurn(process, digestJson(), { input: 5, output: 5, cost: 0 }),
    ]);
    const { cwd, executor, logs } = await harness(() => process);
    const outputDir = join(cwd, "reports", "literature");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, `${STAMP}.md`), "user edited this file", "utf8"); // no manifest → not ours

    const result = await executor.run(task(), "run-4", { cwd, log: log(logs) });
    expect(result.output_paths[0]).toBe(`reports/literature/${STAMP}-${HHMM}.md`);
    expect(await readFile(join(outputDir, `${STAMP}-${HHMM}.md`), "utf8")).toBe(`${MARKDOWN}\n`);
    expect(await readFile(join(outputDir, `${STAMP}.md`), "utf8")).toBe("user edited this file"); // untouched
    expect(logs.some((line) => line.includes("conflict"))).toBe(true);
    const manifest = JSON.parse(await readFile(join(outputDir, `${STAMP}.manifest.json`), "utf8")) as { output_files: Array<{ path: string }> };
    expect(manifest.output_files[0]!.path).toBe(`${STAMP}-${HHMM}.md`);
  });

  it("overwrites the daily file when its hash matches the last manifest", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }),
      () => emitTurn(process, digestJson(), { input: 5, output: 5, cost: 0 }),
    ]);
    const { cwd, executor, logs } = await harness(() => process);
    const outputDir = join(cwd, "reports", "literature");
    await mkdir(outputDir, { recursive: true });
    const previous = "previous agent output\n";
    await writeFile(join(outputDir, `${STAMP}.md`), previous, "utf8");
    await writeFile(join(outputDir, `${STAMP}.manifest.json`), JSON.stringify({ output_files: [{ path: `${STAMP}.md`, sha256: sha256(previous) }] }), "utf8");

    const result = await executor.run(task(), "run-5", { cwd, log: log(logs) });
    expect(result.output_paths[0]).toBe(`reports/literature/${STAMP}.md`); // same day overwrite
    expect(await readFile(join(outputDir, `${STAMP}.md`), "utf8")).toBe(`${MARKDOWN}\n`);
    expect(logs.some((line) => line.includes("conflict"))).toBe(false);
  });

  it("marks the first run as a baseline in the prompt and the log", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }),
      () => emitTurn(process, digestJson(), { input: 5, output: 5, cost: 0 }),
    ]);
    const { cwd, executor, logs } = await harness(() => process);
    const result = await executor.run(task(), "run-first", { cwd, log: log(logs) });
    const message = String(process.commands[1]!.params.message);
    expect(message).toContain("上次运行对比");
    expect(message).toContain("本次为首次运行，建立基线");
    expect(message).toContain("（本次新增）标记");
    expect(logs.some((line) => line.includes("本次为首次运行，建立基线，全部 2 篇视为新增"))).toBe(true);
    expect(result.output_paths).toHaveLength(2);
  });

  it("compares against the latest previous manifest and preserves full source metadata", async () => {
    const currentSources: DigestSource[] = [
      { title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", provider: "arxiv", doi: "10.1/old" },
      { title: "BERT: Pre-training of Deep Bidirectional Transformers", url: "https://arxiv.org/abs/1810.04805", provider: "arxiv", id: "1810.04805", authors: ["Jacob Devlin"], year: 2018, venue: "arXiv" },
    ];
    const process = new FakeAgentProcess([
      () => ({ success: true }),
      () => emitTurn(process, digestJson(MARKDOWN, currentSources), { input: 5, output: 5, cost: 0 }),
    ]);
    const { cwd, executor, logs } = await harness(() => process);
    const outputDir = join(cwd, "reports", "literature");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "2025-01-05.manifest.json"), JSON.stringify({
      run_id: "run-old",
      executed_at: "2025-01-05T09:00:00.000Z",
      sources: [{ title: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762", provider: "arxiv", doi: "10.1/old" }],
    }), "utf8");

    const result = await executor.run(task(), "run-delta", { cwd, log: log(logs) });
    const message = String(process.commands[1]!.params.message);
    expect(message).toContain("上次运行对比");
    expect(message).toContain("上次运行（2025-01-05）共收录 1 篇：Attention Is All You Need");
    expect(logs.some((line) => line.includes("新增 1 篇：BERT: Pre-training of Deep Bidirectional Transformers"))).toBe(true);

    const manifest = JSON.parse(await readFile(join(outputDir, `${STAMP}.manifest.json`), "utf8")) as { sources: DigestSource[] };
    expect(manifest.sources).toEqual(currentSources); // id/authors/year/venue/doi survive into the manifest
    expect(result.output_paths).toHaveLength(2);
  });

  it("uses the previous day as the baseline when today's manifest already exists", async () => {
    const process = new FakeAgentProcess([
      () => ({ success: true }),
      () => emitTurn(process, digestJson(MARKDOWN, [
        { title: "OLD", url: "https://example.com/old", provider: "arxiv", doi: "10.1/old" },
        { title: "NEW", url: "https://example.com/new", provider: "arxiv" },
      ]), { input: 5, output: 5, cost: 0 }),
    ]);
    const { cwd, executor, logs } = await harness(() => process);
    const outputDir = join(cwd, "reports", "literature");
    await mkdir(outputDir, { recursive: true });
    // Same-day earlier run: must NOT become the comparison baseline.
    await writeFile(join(outputDir, `${STAMP}.manifest.json`), JSON.stringify({
      run_id: "run-earlier-today",
      executed_at: "2025-01-06T08:00:00.000Z",
      sources: [{ title: "UNRELATED", url: "https://example.com/unrelated", provider: "arxiv", doi: "10.1/unrelated" }],
    }), "utf8");
    await writeFile(join(outputDir, "2025-01-05.manifest.json"), JSON.stringify({
      run_id: "run-yesterday",
      executed_at: "2025-01-05T09:00:00.000Z",
      sources: [{ title: "OLD", url: "https://example.com/old", provider: "arxiv", doi: "10.1/old" }],
    }), "utf8");

    await executor.run(task(), "run-delta-2", { cwd, log: log(logs) });
    const message = String(process.commands[1]!.params.message);
    expect(message).toContain("上次运行（2025-01-05）共收录 1 篇：OLD");
    // Had today's earlier manifest been used, both OLD and NEW would be new (2 篇).
    expect(logs.some((line) => line.includes("新增 1 篇：NEW"))).toBe(true);
  });

  it("rejects an output path escaping the workspace before starting the agent", async () => {
    const { cwd, manager, executor } = await harness(() => new FakeAgentProcess([]));
    const escaping = task({ output: { relative_path: "../escape.md" } });
    await expect(executor.run(escaping, "run-6", { cwd, log: async () => undefined })).rejects.toThrow(/escapes/);
    expect(manager.started).toEqual([]);
  });

  it("rejects a task without a query", async () => {
    const { cwd, manager, executor } = await harness(() => new FakeAgentProcess([]));
    const noQuery = task({ executor: { kind: "headless_agent", config: { providers: ["arxiv"] } } });
    await expect(executor.run(noQuery, "run-7", { cwd, log: async () => undefined })).rejects.toThrow(/query/);
    expect(manager.started).toEqual([]);
  });
});

describe("parseDigestResponse", () => {
  it("keeps optional metadata fields on sources", () => {
    const digest = parseDigestResponse(JSON.stringify({
      markdown: "# 综述",
      sources: [{ title: "T", url: "https://example.com/t", provider: "pubmed", id: "12345", authors: ["Alice", "Bob"], year: 2024, venue: "Nature", doi: "10.1038/x" }],
    }));
    expect(digest).toEqual({
      markdown: "# 综述",
      sources: [{ title: "T", url: "https://example.com/t", provider: "pubmed", id: "12345", authors: ["Alice", "Bob"], year: 2024, venue: "Nature", doi: "10.1038/x" }],
    });
  });

  it("keeps valid optional fields and drops malformed ones", () => {
    const digest = parseDigestResponse(JSON.stringify({
      markdown: "# 综述",
      sources: [{ title: "T", url: "https://example.com/t", provider: "arxiv", id: 42, authors: ["Alice", 7], year: "2024", doi: 10 }],
    }));
    expect(digest).toEqual({ markdown: "# 综述", sources: [{ title: "T", url: "https://example.com/t", provider: "arxiv", authors: ["Alice"] }] });
  });

  it("rejects a source missing a required field", () => {
    expect(parseDigestResponse(JSON.stringify({ markdown: "# 综述", sources: [{ title: "T", provider: "arxiv" }] }))).toBeNull();
  });
});

describe("computeNewSources", () => {
  const oldSource: DigestSource = { title: "OLD", url: "https://example.com/old", provider: "arxiv", doi: "10.1/old" };

  it("reports every current source as new when there are no previous sources", () => {
    expect(computeNewSources([], [oldSource])).toEqual([oldSource]);
  });

  it("does not count a source as new when its doi repeats", () => {
    const fresh = { title: "NEW", url: "https://example.com/new", provider: "arxiv", doi: "10.1/new" };
    expect(computeNewSources([oldSource], [oldSource, fresh])).toEqual([fresh]);
  });

  it("dedupes by doi: the same url with a different doi counts as new", () => {
    const previous = [{ title: "OLD", url: "https://example.com/old", provider: "arxiv", doi: "10.1/a" }];
    const current = [{ title: "OLD", url: "https://example.com/old", provider: "arxiv", doi: "10.1/b" }];
    expect(computeNewSources(previous, current)).toEqual(current);
  });

  it("dedupes by lowercased id when both sources lack a doi", () => {
    const previous = [{ title: "OLD", url: "https://example.com/old", provider: "arxiv", id: "1234.5678" }];
    const current = [{ title: "OLD", url: "https://example.com/old", provider: "arxiv", id: "1234.5678" }];
    expect(computeNewSources(previous, current)).toEqual([]);
  });
});

describe("buildDeltaNote", () => {
  it("treats the first run as a baseline", () => {
    expect(buildDeltaNote([], [{ title: "A", url: "u", provider: "arxiv" }, { title: "B", url: "v", provider: "arxiv" }], true)).toBe("本次为首次运行，建立基线，全部 2 篇视为新增");
  });

  it("summarizes new sources and truncates beyond five titles", () => {
    const previous = [{ title: "P", url: "p", provider: "arxiv" }];
    const current = [
      { title: "P", url: "p", provider: "arxiv" },
      { title: "N1", url: "n1", provider: "arxiv" },
      { title: "N2", url: "n2", provider: "arxiv" },
      { title: "N3", url: "n3", provider: "arxiv" },
      { title: "N4", url: "n4", provider: "arxiv" },
      { title: "N5", url: "n5", provider: "arxiv" },
      { title: "N6", url: "n6", provider: "arxiv" },
    ];
    expect(buildDeltaNote(previous, current, false)).toBe("新增 6 篇：N1、N2、N3、N4、N5 等");
  });

  it("reports when nothing changed", () => {
    const previous = [{ title: "P", url: "p", provider: "arxiv" }];
    expect(buildDeltaNote(previous, [previous[0]!], false)).toBe("与上次运行相比无新增文献");
  });
});

describe("digestPrompt", () => {
  it("follows the professional report template with a delta note", () => {
    const prompt = digestPrompt("machine learning", ["arxiv", "pubmed"], "focus on transformers", "新增 2 篇：A、B");
    expect(prompt).toContain("http://127.0.0.1:8787/api/literature/search");
    expect(prompt).toContain("检索说明");
    expect(prompt).toContain("执行摘要");
    expect(prompt).toContain("分主题综述");
    expect(prompt).toContain("关键文献评估");
    expect(prompt).toContain("来源清单");
    expect(prompt).toContain("局限与说明");
    expect(prompt).toContain("上次运行对比");
    expect(prompt).toContain("新增 2 篇：A、B");
    expect(prompt).toContain("本次新增");
    expect(prompt).toContain("（本次新增）标记");
    expect(prompt).toContain("600-1200 字");
    expect(prompt).toContain("严格 JSON");
    expect(prompt).not.toContain("300–600 字");
  });

  it("omits the previous-run comparison section without a delta note", () => {
    const prompt = digestPrompt("machine learning", ["arxiv"]);
    expect(prompt).toContain("检索说明");
    expect(prompt).toContain("来源清单");
    expect(prompt).not.toContain("上次运行对比");
    expect(prompt).not.toContain("（本次新增）标记");
  });

  it("keeps the provider and instruction lines", () => {
    const prompt = digestPrompt("machine learning", ["arxiv"], "focus on transformers");
    expect(prompt).toContain("只用这些来源库（providers）：arxiv");
    expect(prompt).toContain("额外要求：focus on transformers");
  });
});

describe("readLatestPreviousManifest", () => {
  it("returns the newest previous manifest, excluding the current run's file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-science-manifest-"));
    cleanup.push(dir);
    await writeFile(join(dir, "2025-01-04.manifest.json"), JSON.stringify({ run_id: "r4", executed_at: "2025-01-04T09:00:00.000Z", sources: [{ title: "A", url: "a", provider: "arxiv" }] }), "utf8");
    await writeFile(join(dir, "2025-01-05.manifest.json"), JSON.stringify({ run_id: "r5", executed_at: "2025-01-05T09:00:00.000Z", sources: [{ title: "B", url: "b", provider: "arxiv" }] }), "utf8");
    // Same-day earlier run: excluded because it is the file this run will write.
    await writeFile(join(dir, "2025-01-06.manifest.json"), JSON.stringify({ run_id: "r6", executed_at: "2025-01-06T08:00:00.000Z", sources: [{ title: "C", url: "c", provider: "arxiv" }] }), "utf8");
    expect(await readLatestPreviousManifest(dir, "2025-01-06.manifest.json", "run-1")).toEqual({
      executedAt: "2025-01-05T09:00:00.000Z",
      sources: [{ title: "B", url: "b", provider: "arxiv" }],
    });
  });

  it("returns null when only the current run's file exists or nothing parses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-science-manifest-"));
    cleanup.push(dir);
    await writeFile(join(dir, "2025-01-06.manifest.json"), JSON.stringify({ run_id: "run-1", executed_at: "2025-01-06T08:00:00.000Z", sources: [] }), "utf8");
    await writeFile(join(dir, "garbage.manifest.json"), "not json", "utf8");
    expect(await readLatestPreviousManifest(dir, "2025-01-06.manifest.json", "run-1")).toBeNull();
  });

  it("skips manifests carrying the current run id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-science-manifest-"));
    cleanup.push(dir);
    await writeFile(join(dir, "2025-01-05.manifest.json"), JSON.stringify({ run_id: "run-1", executed_at: "2025-01-05T09:00:00.000Z", sources: [{ title: "A", url: "a", provider: "arxiv" }] }), "utf8");
    expect(await readLatestPreviousManifest(dir, "2025-01-06.manifest.json", "run-1")).toBeNull();
  });
});
