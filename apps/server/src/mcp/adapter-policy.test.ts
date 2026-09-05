import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

const adapterUrl = new URL("../../../../runtime/pi/node_modules/pi-mcp-adapter/tool-approval.ts", import.meta.url);
// Runtime packages are installed separately from the server workspace.
describe.skipIf(!existsSync(fileURLToPath(adapterUrl)))("installed MCP adapter approval policy", () => {
  it("requires approval for unknown tools and treats grants as exact names", async () => {
    const { isToolCallApprovalRequired } = await import(adapterUrl.href);
    const config = { mcpServers: { test: { approveTools: true, __piScienceAllowedTools: ["safe", "prefix_*"] } } };
    expect(isToolCallApprovalRequired(config, "test", { originalName: "safe" })).toBe(false);
    expect(isToolCallApprovalRequired(config, "test", { originalName: "new_tool" })).toBe(true);
    expect(isToolCallApprovalRequired(config, "test", { originalName: "prefix_delete" })).toBe(true);
  });
  it("refuses headless ask calls and supports approval through the host UI", async () => {
    const { ensureToolCallApproved } = await import(adapterUrl.href);
    const state = { config: { mcpServers: { test: { approveTools: true } } }, approvedToolCalls: new Map() };
    expect(await ensureToolCallApproved(state, "test", { originalName: "tool" }, {})).toEqual({ ok: false, reason: "approval_required_headless" });
    expect(await ensureToolCallApproved({ ...state, ui: { select: async () => "Allow once" } }, "test", { originalName: "tool" }, {})).toEqual({ ok: true });
  });
  it("runs stdio without ambient secrets and preserves bound values without command interpolation", async () => {
    vi.stubEnv("MCP_AMBIENT_SECRET", "must-not-leak");
    const { McpServerManager } = await import(new URL("server-manager.ts", adapterUrl).href);
    const manager = new McpServerManager(process.cwd());
    const script = `
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        let result = {};
        if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
        if (m.method === 'tools/list') result = { tools: [{ name: process.env.MCP_AMBIENT_SECRET ? 'leaked' : 'clean', description: process.env.BOUND_VALUE, inputSchema: { type: 'object' } }] };
        if (m.method === 'resources/list') result = { resources: [] };
        if (m.method === 'prompts/list') result = { prompts: [] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    `;
    try {
      const connection = await manager.connect("fixture", { command: process.execPath, args: ["-e", script], env: { BOUND_VALUE: "!literal-${MCP_AMBIENT_SECRET}" }, __piScienceRawBindings: true });
      expect(connection.tools).toEqual([expect.objectContaining({ name: "clean", description: "!literal-${MCP_AMBIENT_SECRET}" })]);
    } finally { await manager.closeAll(); }
  });

});
