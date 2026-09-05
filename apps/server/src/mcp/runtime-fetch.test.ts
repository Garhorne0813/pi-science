import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpFetch } from "./runtime-fetch.js";
import { recordEgress } from "../security/egress-audit.js";
vi.mock("../security/egress-audit.js", () => ({ egressAuditEnabled: async () => true, recordEgress: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("MCP transport egress", () => {
  it("blocks private destinations and audits the rejection before sending", async () => {
    const request = createMcpFetch({ connectorId: "test", endpoint: "http://127.0.0.1:1/mcp", allowPrivate: false });
    await expect(request("http://127.0.0.1:1/mcp")).rejects.toThrow("private or reserved");
    expect(recordEgress).toHaveBeenCalledWith(expect.objectContaining({ approved: false, connector_id: "test" }));
  });
  it("permits explicitly allowed local traffic, but never follows redirects or cross-origin SSE endpoints", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url!);
      if (req.url === "/redirect") { res.writeHead(302, { location: "/secret" }); res.end(); }
      else { res.end("ok"); }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const request = createMcpFetch({ connectorId: "test", projectId: "project-test", endpoint, allowPrivate: true });
      expect(await (await request(`${endpoint}/mcp`, { method: "POST", body: "message" })).text()).toBe("ok");
      await expect(request(`${endpoint}/redirect`)).rejects.toThrow("redirects are blocked");
      await expect(request("http://127.0.0.1:1/stolen")).rejects.toThrow("cross-origin");
      expect(paths).toEqual(["/mcp", "/redirect"]);
      expect(recordEgress).toHaveBeenCalledWith(expect.objectContaining({ note: "mcp_runtime", approved: true, project_id: "project-test" }));
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
  it.skipIf(!existsSync(fileURLToPath(new URL("../../../../runtime/pi/node_modules/pi-mcp-adapter/server-manager.ts", import.meta.url))))("installed adapter routes its actual handshake through the guard", async () => {
    const { McpServerManager } = await import(new URL("../../../../runtime/pi/node_modules/pi-mcp-adapter/server-manager.ts", import.meta.url).href);
    const manager = new McpServerManager();
    try {
      await expect(manager.connect("blocked", {
        url: "http://127.0.0.1:1/mcp", auth: false,
        __piScienceFetchModule: new URL("./runtime-fetch.ts", import.meta.url).href,
        __piScienceConnectorId: "blocked", __piScienceAllowPrivate: false,
      })).rejects.toThrow();
      expect(recordEgress).toHaveBeenCalledWith(expect.objectContaining({ connector_id: "blocked", approved: false, note: "mcp_network_blocked" }));
    } finally { await manager.closeAll(); }
  });
  it.skipIf(!existsSync(fileURLToPath(new URL("../../../../runtime/pi/node_modules/pi-mcp-adapter/mcp-auth-flow.ts", import.meta.url))))("installed adapter routes OAuth discovery and token traffic through the guard", async () => {
    const { startAuth } = await import(new URL("../../../../runtime/pi/node_modules/pi-mcp-adapter/mcp-auth-flow.ts", import.meta.url).href);
    const endpoint = "http://127.0.0.1:1/mcp";
    await expect(startAuth("oauth-blocked", endpoint, {
      url: endpoint,
      auth: "oauth",
      oauth: { grantType: "client_credentials", clientId: "client" },
      __piScienceFetchModule: new URL("./runtime-fetch.ts", import.meta.url).href,
      __piScienceConnectorId: "oauth-blocked",
      __piScienceProjectId: "project-oauth",
      __piScienceAllowPrivate: false,
    })).rejects.toThrow();
    expect(recordEgress).toHaveBeenCalledWith(expect.objectContaining({ connector_id: "oauth-blocked", project_id: "project-oauth", approved: false }));
  });

});
