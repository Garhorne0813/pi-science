import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { builtinMcpConnectors } from "./builtin-connectors.js";
import { mcpBaseEnvironment } from "./bindings.js";
import { McpRepository } from "../storage/sqlite/repositories/mcp-repository.js";
import { InMemorySqliteStateStore } from "../storage/sqlite/state-store.js";
import { McpRuntimeProjection } from "./runtime-projection.js";
import { AgentMcpTools } from "../runtime/agent/worker/mcp-tools.js";
import { InteractionBridge } from "../runtime/agent/worker/interaction-bridge.js";
import { toolEnvironment } from "../runtime/agent/agent-runtime-environment.js";

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "trusted-host"));

const webAccess = () => builtinMcpConnectors().find((item) => item.connector_id === "mcp_builtin_web_access")!;
const resultText = (result: CallToolResult) => result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");

// Exercise the published CLI and its real extraction/cache implementation. Only
// outbound HTTP responses are fixtures; no internet or API key is needed in CI.
async function fixture(settings: Record<string, unknown> | null = { provider: "exa", exaApiKey: "fixture-key" }, environment: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-web-access-"));
  const configRoot = join(cwd, "data", "mcp", "web-access");
  await mkdir(configRoot, { recursive: true });
  if (settings) await writeFile(join(configRoot, "config.json"), JSON.stringify(settings));
  const foreign = join(cwd, "foreign");
  const home = join(cwd, "home");
  const xdg = join(cwd, "xdg");
  for (const directory of [foreign, join(home, ".pi", "agent"), join(xdg, "pi")]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "web-search.json"), JSON.stringify({ provider: "brave", braveApiKey: "foreign-key", proxy: "http://foreign:8080", ssrf: { allowRanges: ["127.0.0.0/8"], trustEnvProxy: true }, tools: { fetchContent: { enabled: false } } }));
  }
  const preload = join(cwd, "http-fixture.mjs");
  await writeFile(preload, `
import { writeFileSync } from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "api.search.brave.com") {
    writeFileSync("provider-called", "brave");
    return Response.json({ web: { results: [{ title: "Brave fixture", url: "https://93.184.216.34/page", description: "Configured Provider" }] } });
  }
  if (url.hostname === "api.exa.ai") return Response.json({ results: [
    { title: "Research fixture", url: "https://93.184.216.34/page", text: "Scientific evidence fixture" }
  ] });
  if (url.hostname !== "93.184.216.34") throw new Error("Unexpected outbound request: " + url);
  if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  if (url.pathname === "/oversized") return new Response("too large", { headers: { "content-type": "text/plain", "content-length": "999999999" } });
  if (url.pathname === "/slow") return new Promise((resolve, reject) => {
    writeFileSync("started", "yes");
    init.signal.addEventListener("abort", () => { writeFileSync("aborted", "yes"); reject(new Error("aborted")); }, { once: true });
  });
  return new Response("Scientific evidence fixture. " + "Page content. ".repeat(100), { headers: { "content-type": "text/plain" } });
};
`);
  vi.stubEnv("PI_SCIENCE_HOME", join(cwd, "data"));
  const builtin = webAccess();
  const transport = new StdioClientTransport({
    command: builtin.definition.command!, args: ["--import", pathToFileURL(preload).href, ...builtin.definition.args],
    cwd, env: { ...mcpBaseEnvironment(), PI_SCIENCE_HOME: join(cwd, "wrong-child-root"), PI_CODING_AGENT_DIR: foreign, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, ...environment }, stderr: "pipe",
  });
  const client = new Client({ name: "pi-science-web-access-test", version: "1" });
  try { await client.connect(transport); }
  catch (error) { await client.close(); await rm(cwd, { recursive: true, force: true }); throw error; }
  return { client, transport, cwd, close: async () => { await client.close(); await rm(cwd, { recursive: true, force: true }); } };
}

describe("published Web Access MCP", () => {
  it("resolves the pinned CLI and discovers matching tools without extension-only parameters", async () => {
    const builtin = webAccess();
    expect(builtin.definition.command).toBe(process.execPath);
    expect(JSON.parse(await readFile(new URL(import.meta.resolve("pi-web-access/package.json")), "utf8")).version).toBe("0.40.0");
    const f = await fixture();
    try {
      const { tools } = await f.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(builtin.tools.map((tool) => tool.name).sort());
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(builtin.tools.find((item) => item.name === tool.name)?.read_only);
        for (const name of ["workflow", "curator", "auth", "frames", "timestamp"]) expect(tool.inputSchema.properties).not.toHaveProperty(name);
      }
    } finally { await f.close(); }
    expect(f.transport.pid).toBeNull();
  });

  it("generates isolated production defaults without inheriting HOME, XDG or a bound Pi directory", async () => {
    const f = await fixture(null);
    try {
      const { tools } = await f.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(webAccess().tools.map((tool) => tool.name).sort());
      const config = JSON.parse(await readFile(join(f.cwd, "data", "mcp", "web-access", "runtime", "web-search.json"), "utf8"));
      expect(config).toEqual({
        provider: "auto", githubClone: { enabled: false }, githubPrIssue: { enabled: false },
        ssrf: { allowRanges: [], trustEnvProxy: false },
        tools: Object.fromEntries(["webSearch", "fetchContent", "getSearchContent", "sourceCheck"].map((name) => [name, { enabled: true }])),
      });
      const result = await f.client.callTool({ name: "fetch_content", arguments: { url: "http://127.0.0.1/", mode: "raw" } });
      expect(result.isError).toBe(true);
      expect(resultText(result as CallToolResult)).toMatch(/blocked/i);
    } finally { await f.close(); }
  });

  it("preserves explicit Provider settings while keeping the managed tool directory and guards", async () => {
    const settings = { provider: "brave", githubClone: { enabled: true }, githubPrIssue: { enabled: true },
      ssrf: { allowRanges: ["127.0.0.0/8"], trustEnvProxy: true },
      tools: { webSearch: { enabled: false }, fetchContent: { enabled: false }, getSearchContent: { enabled: false }, sourceCheck: { enabled: false } } };
    const f = await fixture(settings, { BRAVE_API_KEY: "fixture-brave-key" });
    try {
      expect((await f.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(webAccess().tools.map((tool) => tool.name).sort());
      const config = JSON.parse(await readFile(join(f.cwd, "data", "mcp", "web-access", "runtime", "web-search.json"), "utf8"));
      expect(config).toMatchObject({ provider: "brave", githubClone: { enabled: false }, githubPrIssue: { enabled: false }, ssrf: { allowRanges: [], trustEnvProxy: false } });
      expect(JSON.parse(await readFile(join(f.cwd, "data", "mcp", "web-access", "config.json"), "utf8"))).toEqual(settings);
      const result = await f.client.callTool({ name: "web_search", arguments: { query: "configured Provider" } });
      expect(result.isError).not.toBe(true);
      expect(resultText(result as CallToolResult)).toContain("Brave fixture");
      expect(await readFile(join(f.cwd, "provider-called"), "utf8")).toBe("brave");
    } finally { await f.close(); }
  });

  it("uses the control-plane data root through the real projection and Worker tool environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-web-worker-"));
    const dataRoot = join(cwd, "control plane data");
    vi.stubEnv("PI_SCIENCE_HOME", dataRoot);
    const state = new InMemorySqliteStateStore();
    let mcp: AgentMcpTools | undefined;
    try {
      await mkdir(join(cwd, ".pi-science"));
      const configDirectory = join(dataRoot, "mcp", "web-access");
      await mkdir(configDirectory, { recursive: true });
      await writeFile(join(configDirectory, "config.json"), JSON.stringify({ provider: "brave", maxInlineContentChars: 12345 }));
      await state.start();
      const repository = new McpRepository(state);
      const builtin = webAccess();
      const connector = await repository.upsertBuiltin(builtin.connector_id, builtin.definition, true);
      await repository.updateSettings(builtin.connector_id, { enabled: true, include_tools: [], exclude_tools: [], approval_mode: "allow_all", revision: connector.settings_revision });
      await new McpRuntimeProjection(repository).materialize(cwd, "project_web_access");
      const environment = { PATH: process.env.PATH ?? "", HOME: join(cwd, "worker-home"), PI_SCIENCE_HOME: dataRoot };
      expect(toolEnvironment(environment)).not.toHaveProperty("PI_SCIENCE_HOME");
      mcp = await AgentMcpTools.open(cwd, new InteractionBridge(() => undefined), environment);
      expect(mcp.diagnostics).toEqual([]);
      expect(mcp.tools.map((tool) => tool.name).sort()).toEqual(builtin.tools.map((tool) => `mcp__web-access__${tool.name}`).sort());
      const generated = JSON.parse(await readFile(join(configDirectory, "runtime", "web-search.json"), "utf8"));
      expect(generated).toMatchObject({ provider: "brave", maxInlineContentChars: 12345 });
      await expect(readFile(join(cwd, "worker-home", ".pi-science", "mcp", "web-access", "runtime", "web-search.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const tool = mcp.tools.find((tool) => tool.name.endsWith("__get_search_content"))!;
      const result = await tool.execute("missing-cache", { responseId: "unknown" }, () => undefined, {} as never, {} as never, {} as never);
      expect(result).toMatchObject({ isError: true });
    } finally {
      await mcp?.close();
      await state.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);

  it("searches, fetches and pages cached content in the same CLI process", async () => {
    const f = await fixture();
    try {
      const search = await f.client.callTool({ name: "web_search", arguments: { query: "scientific evidence", provider: "exa" } });
      expect(search.isError).not.toBe(true);
      expect(resultText(search as CallToolResult)).toContain("Research fixture");
      const fetched = await f.client.callTool({ name: "fetch_content", arguments: { url: "https://93.184.216.34/page", mode: "raw" } });
      expect(fetched.isError).not.toBe(true);
      const id = resultText(fetched as CallToolResult).match(/responseId "([^"]+)"/)?.[1];
      expect(id).toBeTruthy();
      const page = await f.client.callTool({ name: "get_search_content", arguments: { responseId: id, urlIndex: 0, offset: 0, limit: 28 } });
      expect(page.isError).not.toBe(true);
      expect(resultText(page as CallToolResult)).toContain("Scientific evidence fixture.");
      const check = await f.client.callTool({ name: "source_check", arguments: { claim: "Scientific evidence", provider: "exa", fetchContent: false } });
      expect(check.isError).not.toBe(true);
    } finally { await f.close(); }
  });

  it("rejects private targets, non-HTTP URLs, private redirects and oversized responses", async () => {
    const f = await fixture();
    try {
      for (const url of ["http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "file:///etc/passwd", "https://93.184.216.34/redirect", "https://93.184.216.34/oversized"]) {
        const result = await f.client.callTool({ name: "fetch_content", arguments: { url, mode: "raw" } });
        expect(result.isError, url).toBe(true);
        expect(resultText(result as CallToolResult), url).toMatch(/blocked|only http|too large/i);
      }
    } finally { await f.close(); }
  });

  it("forwards cancellation to an active fetch and closes the subprocess", async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const pending = f.client.callTool({ name: "fetch_content", arguments: { url: "https://93.184.216.34/slow", mode: "raw" } }, undefined, { signal: controller.signal }).catch((error: unknown) => error);
      await expect.poll(() => readFile(join(f.cwd, "started"), "utf8").catch(() => "")).toBe("yes");
      controller.abort();
      await pending;
      await expect.poll(() => readFile(join(f.cwd, "aborted"), "utf8").catch(() => "")).toBe("yes");
    } finally { await f.close(); }
    expect(f.transport.pid).toBeNull();
  });
});
