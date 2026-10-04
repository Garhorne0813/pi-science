import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../security/egress-audit.js", () => ({ egressAuditEnabled: async () => false }));
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("uses the launch proxy for public traffic while retaining origin, private-address and redirect guards", async () => {
  const paths: string[] = [];
  const tunnels: string[] = [];
  const target = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url === "/redirect") res.writeHead(302, { location: "http://127.0.0.1/secret" });
    res.end("proxied result");
  });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const proxy = createServer();
  proxy.on("connect", (req, socket, head) => {
    tunnels.push(req.url!);
    const upstream = connect((target.address() as { port: number }).port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  vi.stubEnv("http_proxy", `http://127.0.0.1:${(proxy.address() as { port: number }).port}`);
  vi.stubEnv("no_proxy", "");
  vi.resetModules();
  try {
    const { createMcpFetch } = await import("./runtime-fetch.js");
    const request = createMcpFetch({ connectorId: "proxy-test", endpoint: "http://example.test", allowPrivate: false });
    expect(await (await request("http://example.test/mcp")).text()).toBe("proxied result");
    await expect(request("http://example.test/redirect")).rejects.toThrow("redirects are blocked");
    await expect(request("http://127.0.0.1/private")).rejects.toThrow("cross-origin");
    const privateRequest = createMcpFetch({ connectorId: "private", endpoint: "http://127.0.0.1", allowPrivate: false });
    await expect(privateRequest("http://127.0.0.1/private")).rejects.toThrow("private or reserved");
    expect(tunnels.length).toBeGreaterThan(0);
    expect(tunnels.every((address) => address === "example.test:80")).toBe(true);
    expect(paths).toEqual(["/mcp", "/redirect"]);
  } finally {
    target.closeAllConnections(); proxy.closeAllConnections();
    // CONNECT sockets are not owned by closeAllConnections; target closure
    // tears down their upstream pipes before awaiting the listening sockets.
    await Promise.all([new Promise<void>((done) => target.close(() => done())), new Promise<void>((done) => proxy.close(() => done()))]);
  }
}, 15000);
