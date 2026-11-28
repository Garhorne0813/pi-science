import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../../types/thread";
import { projectToolActivity } from "../../../lib/conversation/projection";
import { ActivityRendererRegistry, activityRendererRegistry } from "./registry";

const t = (key: string, values: Record<string, unknown> = {}) => `${key}:${Object.values(values).join(":")}`;
const tool = (name: string, extra: Partial<ToolCallBlock> = {}): ToolCallBlock => ({ kind: "tool", id: name, callId: `${name}-call`, tool: name, status: "done", ...extra });

describe("ActivityRendererRegistry", () => {
  it("selects scientific renderers by projection kind", () => {
    const python = tool("python", { details: { outputs: [{}, {}] } });
    const pubmed = tool("search_pubmed", {
      title: "Running search pubmed",
      details: {
        structuredContent: {
          count: 3,
          total: 3,
          request: { provider: "pubmed", query: "kinase", limit: 3, offset: 0 },
          warnings: [],
          records: [{}, {}, {}],
        },
      },
    });
    const pythonView = activityRendererRegistry.resolve(projectToolActivity(python).kind).compact({ activity: projectToolActivity(python), source: python, live: false, t });
    const pubmedView = activityRendererRegistry.resolve(projectToolActivity(pubmed).kind).compact({ activity: projectToolActivity(pubmed), source: pubmed, live: false, t });
    expect(pythonView).toEqual({ title: "conversation.activity.kernelComplete:Python", detail: "conversation.activity.outputCount:2" });
    expect(pubmedView).toEqual({ title: "PubMed", detail: "conversation.activity.resultCount:3" });
  });

  it("uses paper-search providers and result envelopes for literature metadata", () => {
    const arxiv = tool("search_arxiv", {
      title: "Running search arxiv",
      details: {
        structuredContent: {
          count: 2,
          request: { provider: "arxiv", query: "kinase", limit: 2, offset: 0 },
          records: [{}, {}],
        },
      },
    });
    const arxivView = activityRendererRegistry.resolve(projectToolActivity(arxiv).kind).compact({
      activity: projectToolActivity(arxiv),
      source: arxiv,
      live: false,
      t,
    });
    expect(arxivView).toEqual({ title: "arXiv", detail: "conversation.activity.resultCount:2" });

    const medrxivRunning = tool("search_biorxiv_preprints", {
      status: "running",
      title: "Running search biorxiv preprints",
      input: { server: "medrxiv" },
    });
    const medrxivRunningView = activityRendererRegistry.resolve(projectToolActivity(medrxivRunning).kind).compact({
      activity: projectToolActivity(medrxivRunning),
      source: medrxivRunning,
      live: true,
      t,
    });
    expect(medrxivRunningView.title).toBe("conversation.activity.literatureRunning:medRxiv");

    const medrxiv = tool("search_biorxiv_preprints", {
      input: { server: "medrxiv" },
      details: {
        structuredContent: {
          count: 1,
          request: { provider: "biorxiv", server: "medrxiv", query: "outbreak", limit: 1, offset: 0 },
          records: [{}],
        },
      },
    });
    const medrxivView = activityRendererRegistry.resolve(projectToolActivity(medrxiv).kind).compact({
      activity: projectToolActivity(medrxiv),
      source: medrxiv,
      live: false,
      t,
    });
    expect(medrxivView.title).toBe("medRxiv");

    const fullText = tool("get_europe_pmc_full_text", {
      details: {
        structuredContent: {
          count: 1,
          request: { provider: "europepmc" },
          records: [{}],
        },
      },
    });
    const fullTextView = activityRendererRegistry.resolve(projectToolActivity(fullText).kind).compact({
      activity: projectToolActivity(fullText),
      source: fullText,
      live: false,
      t,
    });
    expect(fullTextView.title).toBe("Europe PMC");
  });

  it("keeps broad research activities out of the literature renderer", () => {
    const grep = tool("grep", {
      title: "Searching for tool.updated",
      presentation: {
        version: 1,
        kind: "search",
        title: "Searching for tool.updated",
        importance: "micro",
        domain: "research",
      },
    });
    expect(projectToolActivity(grep).kind).toBe("file");
    expect([
      "search_pubmed",
      "search_arxiv",
      "search_crossref",
      "search_biorxiv_preprints",
      "get_europe_pmc_full_text",
    ].map((name) => projectToolActivity(tool(name)).kind)).toEqual([
      "literature",
      "literature",
      "literature",
      "literature",
      "literature",
    ]);
  });

  it("preserves semantic titles while adding renderer detail", () => {
    const python = tool("python", {
      title: "Fit Michaelis-Menten model",
      details: { outputs: [{}, {}] },
    });
    const view = activityRendererRegistry.resolve(projectToolActivity(python).kind).compact({
      activity: projectToolActivity(python),
      source: python,
      live: false,
      t,
    });
    expect(view.title).toBe("Fit Michaelis-Menten model");
    expect(view.detail).toContain("Python");
    expect(view.detail).toContain("outputCount:2");
  });

  it("always falls back for unknown renderer keys", () => {
    const registry = new ActivityRendererRegistry();
    const unknown = tool("future_science_tool", { title: "Future analysis" });
    expect(registry.resolve("not-registered").compact({ activity: projectToolActivity(unknown), source: unknown, live: false, t })).toEqual({ title: "Future analysis" });
  });

  it("keeps the native notebook renderer and task description", () => {
    const source = tool("notebook_run", { input: { description: "分析实验数据", path: "analysis.ipynb" } });
    const activity = projectToolActivity(source);
    expect(activity.kind).toBe("kernel");
    const view = activityRendererRegistry.resolve(activity.kind).compact({ activity, source, live: false, t });
    expect(view.title).toBe("分析实验数据");
    expect(view.detail).toContain("Python");
  });

  it.each(["python", "r", "search_pubmed", "read_file", "get_pdb_entry", "subagent"])("uses generic MCP rendering even when %s resembles a built-in tool", (name) => {
    const source = tool(`mcp__custom__${name}`, { input: { description: "Resource description", query: "kinase", path: "data.csv" }, details: { count: 4 } });
    const activity = projectToolActivity(source);
    expect(activity.kind).toBe("tool");
    const renderer = activityRendererRegistry.resolve(activity.kind);
    expect(renderer.compact({ activity, source, live: false, t })).toEqual({ title: `custom · ${name}` });
    const details = renderer.expanded({ activity, source, live: false, t });
    expect(details.find(row => row.label.startsWith("conversation.activity.input"))?.value).toContain('"query": "kinase"');
    expect(details.find(row => row.label.startsWith("conversation.activity.toolLabel"))?.value).toBe(source.tool);
  });

  it("projects persisted file changes into a compact tool-event summary", () => {
    const edit = tool("edit", {
      input: { path: "src/app.ts" },
      details: { fileChange: { path: "src/app.ts", additions: 12, deletions: 3, patch: "@@\n-old\n+new" } },
    });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(edit).kind);
    expect(renderer.compact({ activity: projectToolActivity(edit), source: edit, live: false, t })).toEqual({
      title: "conversation.activity.write:app.ts",
      detail: "src/app.ts",
      fileChange: { path: "src/app.ts", additions: 12, deletions: 3 },
    });
    expect(renderer.expanded({ activity: projectToolActivity(edit), source: edit, live: false, t })).toContainEqual(expect.objectContaining({
      label: "conversation.activity.diff:",
      value: "@@\n-old\n+new",
    }));
  });

  it("shows only the command for bash input instead of repeating description JSON", () => {
    const bash = tool("bash", {
      title: "Run frontend tests",
      input: { description: "Run frontend tests", command: "pnpm --filter frontend test", timeout: 600 },
      presentation: { version: 1, kind: "verify", title: "Run frontend tests", description: "Run frontend tests", importance: "stage", domain: "code" },
      details: { verification: { passed: 12, failed: 0, skipped: 1 }, execution: { exitCode: 0, id: "exec-1" } },
    });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(bash).kind);
    expect(renderer.compact({ activity: projectToolActivity(bash), source: bash, live: false, t })).toEqual({
      title: "Run frontend tests",
      detail: "conversation.activity.testsPassed: · conversation.activity.testsPassedCount:12 · conversation.activity.testsSkippedCount:1 · conversation.activity.exitCode:0",
    });
    const expanded = renderer.expanded({ activity: projectToolActivity(bash), source: bash, live: false, t });
    expect(expanded).toContainEqual({ label: "conversation.activity.command:", value: "pnpm --filter frontend test", pre: true });
    expect(expanded).not.toContainEqual(expect.objectContaining({ label: "conversation.activity.input:" }));
    expect(expanded.map((row) => row.value).join("\n")).not.toContain("Run frontend tests");
  });

  it("uses semantic input rows for known tools", () => {
    const read = tool("read", { input: { description: "Inspect config", path: "src/config.ts" } });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(read).kind);
    const expanded = renderer.expanded({ activity: projectToolActivity(read), source: read, live: false, t });
    expect(expanded).toContainEqual({ label: "conversation.activity.filePath:", value: "src/config.ts", plain: true });
    expect(expanded).not.toContainEqual(expect.objectContaining({ label: "conversation.activity.input:" }));
  });

  it("filters repeated descriptions from unknown-tool input fallback", () => {
    const future = tool("future_tool", { input: { description: "Do the future thing", option: "safe" } });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(future).kind);
    const expanded = renderer.expanded({ activity: projectToolActivity(future), source: future, live: false, t });
    expect(expanded).toContainEqual({ label: "conversation.activity.input:", value: "{\n  \"option\": \"safe\"\n}", pre: true });
    expect(expanded.map((row) => row.value).join("\n")).not.toContain("Do the future thing");
  });

  it("summarizes parallel subagents and expands each result", () => {
    const subagent = tool("subagent", {
      input: { tasks: [{ agent: "reviewer", task: "Review the change" }, { agent: "tester", task: "Run tests" }] },
      details: { mode: "parallel", results: [
        { agent: "reviewer", task: "Review the change", exitCode: 0, output: "Looks good" },
        { agent: "tester", task: "Run tests", exitCode: 1, error: "One test failed" },
      ] },
    });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(subagent).kind);
    expect(renderer.compact({ activity: projectToolActivity(subagent), source: subagent, live: false, t })).toEqual({
      title: "conversation.activity.subagentsComplete:2",
      detail: "conversation.activity.subagentResultSummary:1:1",
    });
    const expanded = renderer.expanded({ activity: projectToolActivity(subagent), source: subagent, live: false, t });
    expect(expanded).toContainEqual(expect.objectContaining({ label: "reviewer", value: expect.stringContaining("Looks good") }));
    expect(expanded).toContainEqual(expect.objectContaining({ label: "tester", value: expect.stringContaining("One test failed") }));
  });

  it("presents subagent control calls without raw input JSON", () => {
    const control = tool("subagent_control", { input: { action: "collect", task_id: "task-1", wait_seconds: 30 }, details: { status: "completed" } });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(control).kind);
    expect(renderer.compact({ activity: projectToolActivity(control), source: control, live: false, t })).toEqual({
      title: "conversation.activity.subagentControl.collected:",
      detail: "conversation.activity.subagentControl.status.completed:",
    });
    const expanded = renderer.expanded({ activity: projectToolActivity(control), source: control, live: false, t });
    expect(expanded).toContainEqual({ label: "conversation.activity.action:", value: "collect", plain: true });
    expect(expanded).toContainEqual({ label: "conversation.activity.taskId:", value: "task-1", plain: true });
    expect(expanded).not.toContainEqual(expect.objectContaining({ label: "conversation.activity.input:" }));
  });

  it("keeps an asynchronously dispatched subagent running after its tool call returns", () => {
    const dispatched = tool("subagent", {
      input: { agent: "reviewer", task: "Review later", wait_seconds: 0 },
      details: { task_id: "task-1", status: "running" },
    });
    const renderer = activityRendererRegistry.resolve(projectToolActivity(dispatched).kind);
    expect(renderer.compact({ activity: projectToolActivity(dispatched), source: dispatched, live: false, t })).toEqual({
      title: "conversation.activity.subagentRunningNamed:reviewer",
      detail: "conversation.activity.subagentProgress:0:1",
    });
  });
});
