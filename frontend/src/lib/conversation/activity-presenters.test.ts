import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { presentToolActivity, toolActivityCategory } from "./activity-presenters";
const block = (tool: string, input?: Record<string, unknown>, title?: string): ToolCallBlock => ({ kind: "tool", id: tool, callId: tool, tool, status: "running", input, title });

describe("presentToolActivity", () => {
  it("prefers the server title", () => { expect(presentToolActivity(block("bash", {}, "Running tests"))).toBe("Running tests"); });
  it("presents file and search actions", () => { expect(presentToolActivity(block("read", { path: "src/file.ts" }))).toBe("Reading file.ts"); expect(presentToolActivity(block("grep", { pattern: "tool.updated" }))).toBe("Searching for tool.updated"); });
  it("keeps the query when a search call also carries a scope path", () => {
    const grep = presentToolActivity(block("grep", { pattern: "needle", path: "src/deep/file.ts" }));
    expect(grep).toContain("needle");
    expect(grep).not.toContain("file.ts");
    expect(presentToolActivity(block("glob", { pattern: "**/*.ts", path: "frontend" }))).toContain("**/*.ts");
  });
  it("names the url a fetch opens instead of the server's placeholder", () => {
    const call: ToolCallBlock = { ...block("web_fetch", { url: "https://example.com/a" }), presentation: { version: 1, kind: "fetch", title: "Running web fetch", importance: "micro", domain: "research" } };
    expect(presentToolActivity(call)).toBe("Fetching https://example.com/a");
  });
  it("rebuilds a read row in the active locale", () => {
    const labels: Record<string, string> = { "conversation.activity.read": "读取 {{target}}" };
    const zh = (key: string, values?: Record<string, unknown>) => (labels[key] ?? key).replace("{{target}}", String(values?.target ?? ""));
    const call: ToolCallBlock = { ...block("read", { path: "a.ts", offset: 120, limit: 40 }), presentation: { version: 1, kind: "read", title: "Reading a.ts:120-159", importance: "micro", domain: "code" } };
    const row = presentToolActivity(call, zh);
    expect(row).toContain("读取");
    expect(row).not.toContain("Reading");
    expect(row).toContain("a.ts:120-159");
  });
  it("does not promote a stored command preview from a shell presentation title", () => {
    const title = presentToolActivity({ ...block("bash", { command: "python analysis/aggregate.py --condition SAH" }), presentation: { version: 1, kind: "execute", title: "python analysis/aggregate.py --condition SAH", importance: "micro", domain: "code" } });
    expect(title).toBe("Running python");
    expect(title).not.toContain("aggregate.py");
  });
  it("names the program that runs, never its arguments", () => {
    expect(presentToolActivity(block("bash", { command: "pnpm test", description: "Running tests" }))).toBe("Running tests");
    expect(presentToolActivity(block("bash", { command: "/usr/bin/pnpm --filter web test" }))).toBe("Running pnpm");
    const destructive = presentToolActivity(block("bash", { command: "rm -rf x" }));
    expect(destructive).toBe("Running rm");
    expect(destructive).not.toContain("-rf");
    expect(presentToolActivity(block("bash", { command: 'echo "第 1 次调用"; date; hostname' }))).toBe("Running bash");
  });
  it("names the document a kernel tool opens", () => {
    expect(presentToolActivity(block("notebook_run", { path: "/repo/work/analysis.ipynb" }))).toBe("Running analysis.ipynb");
    expect(presentToolActivity(block("notebook_run", {}))).toBe("Running notebook");
    expect(presentToolActivity(block("r", { code: "x <- 1" }))).toBe("Running r");
  });
  it("drops a description that repeats the command", () => {
    const title = presentToolActivity(block("bash", { command: "TOKEN=secret_value pnpm test", description: "Run TOKEN=secret_value pnpm test" }));
    // An assignment makes the command unverifiable, so the row falls back to the
    // neutral tool name rather than naming a program it cannot trust.
    expect(title).toBe("Running bash");
    expect(title).not.toContain("secret_value");
  });
  it("scrubs a credential out of a purpose it does keep", () => {
    expect(presentToolActivity(block("bash", { command: "pnpm test", description: "Run with TOKEN=abc123" }))).toBe("Run with TOKEN=[redacted]");
  });
  it("ignores a stored command preview used as a title", () => {
    const title = presentToolActivity(block("bash", { command: "pnpm test" }, "TOKEN=secret_value pnpm test"));
    expect(title).toBe("Running pnpm");
    expect(title).not.toContain("secret_value");
  });
  it("scrubs a credential out of a presentation title", () => {
    const described: ToolCallBlock = { ...block("future_tool"), presentation: { version: 1, kind: "search", title: "Look up TOKEN=abc123", importance: "micro", domain: "research" } };
    expect(presentToolActivity(described)).toBe("Look up TOKEN=[redacted]");
  });
  it("names the slice that is read with and without the server title", () => {
    expect(presentToolActivity(block("read", { path: "/repo/apps/server/src/a.ts", offset: 120, limit: 40 }))).toBe("Reading a.ts:120-159");
    expect(presentToolActivity({ ...block("read", { path: "/repo/apps/server/src/a.ts", offset: 120, limit: 40 }), presentation: { version: 1, kind: "read", title: "Reading a.ts:120-159", importance: "micro", domain: "code" } })).toBe("Reading a.ts:120-159");
    expect(presentToolActivity(block("read", { path: "/repo/apps/server/src/a.ts" }))).toBe("Reading a.ts");
  });
  it("keeps a scientific query intact and does not read it as a credential", () => {
    expect(presentToolActivity(block("web_search", { query: "secreted protein folding" }))).toBe("Searching the web for secreted protein folding");
    expect(presentToolActivity(block("grep", { pattern: "secretory pathway analysis" }))).toBe("Searching for secretory pathway analysis");
    expect(presentToolActivity(block("web_search", { query: "token binding kinase" }))).toBe("Searching the web for token binding kinase");
  });
  it("shows only the fetchable part of a URL", () => {
    expect(presentToolActivity(block("web_fetch", { url: "https://user:pass@example.com/paper?token=secret" }))).toBe("Fetching https://example.com/paper");
  });
  it.each([
    ["search_memory", { q: "回复语言" }, "Search memory · 回复语言"],
    ["read_memory", { id: "7dcc186c-9a84-4dfc-9248-5000cd726be7" }, "Read memory · 7dcc186…"],
    ["write_memory", { operation: "append", content: { title: "工具连通性测试记录" } }, "Update memory · 工具连通性测试记录"],
    ["verify_citations", { text: "a DOI to check" }, "Verify citations"],
    ["read_source_evidence", { source: "arxiv:2211.16742" }, "Read source evidence · arxiv:2211.16742"],
    ["cite_evidence", { selections: [{ source: "arxiv:2211.16742", passage_ids: ["p1"] }] }, "Record evidence citations · arxiv:2211.16742"],
    ["subagent", { agent: "researcher", task: "Run a test" }, "Delegate task · researcher"],
    ["subagent_control", { action: "list" }, "List subagents"],
    ["subagent_control", { action: "status", id: "test" }, "Check subagent status"],
  ])("presents actual session parameters for %s", (name, input, expected) => {
    expect(presentToolActivity(block(name as string, input as Record<string, unknown>))).toBe(expected);
  });
  it.each(["read_file", "python", "search_pubmed", "get_pdb_entry", "subagent", "bash"])("shows MCP identity without interpreting %s or its parameters", (name) => {
    const source = block(`mcp__custom-server__${name}`, {
      description: "This is resource content, not a task title",
      query: "private query", command: "echo private", pdb_id: "1LYZ",
    }, "A title that must not override MCP identity");
    expect(presentToolActivity(source)).toBe(`custom-server · ${name}`);
  });
});

describe("toolActivityCategory", () => {
  it.each([
    ["read", "read"], ["Grep", "search"], ["glob", "browse"], ["apply_patch", "edit"], ["bash", "execute"],
    ["notebook_run", "compute"], ["r", "compute"], ["rscript", "compute"], ["r_kernel", "compute"],
    ["web_fetch", "web"], ["fetch_url", "web"], ["read_url", "web"],
    ["pubmed", "literature"], ["image_gen", "generate"], ["task", "delegate"], ["subagent_control", "delegate"], ["plan", "other"],
  ])("classifies %s", (name, category) => { expect(toolActivityCategory(block(name))).toBe(category); });
  it("uses kind only for unknown tools and prioritizes child sessions", () => {
    expect(toolActivityCategory({ ...block("extension"), presentation: { version: 1, kind: "fetch", title: "Fetch", importance: "micro", domain: "generic" } })).toBe("web");
    expect(toolActivityCategory({ ...block("read"), childSessionId: "child" })).toBe("delegate");
  });
  it.each(["python", "read_file", "search_pubmed", "bash"])("does not lend built-in semantics to an MCP name ending in %s", (name) => {
    expect(toolActivityCategory(block(`mcp__custom-server__${name}`))).toBe("other");
  });
  it("classifies an MCP tool only by the kind it reports", () => {
    expect(toolActivityCategory({ ...block("mcp__custom-server__python"), presentation: { version: 1, kind: "search", title: "Search", importance: "micro", domain: "research" } })).toBe("search");
  });
});

describe("safe fallbacks", () => {
  it.each(["TOKEN=secret cmd", "env cmd", "cmd | other", "cmd 'secret'", "cmd\nother"])("rejects %s", (command) => { expect(presentToolActivity(block("bash", { command }))).toBe("Running bash"); });
  it.each([[{ path: "a.ts", offset: 120, limit: 40 }, "Reading a.ts:120-159"], [{ path: "a.ts", offset: 120 }, "Reading a.ts:120"], [{ path: "a.ts" }, "Reading a.ts"], [{ path: "a.ts", offset: -1 }, "Reading a.ts"]])("formats read target", (input, expected) => { expect(presentToolActivity(block("read", input))).toBe(expected); });
});
