import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { safeConnectorFetch, validateConnectorOutboundUrl } from "./outbound-security.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === "private.example.com") return [{ address: "10.9.9.9", family: 4 }];
    if (hostname === "public.example.com") return [{ address: "93.184.216.34", family: 4 }];
    if (hostname === "other-public.example.com") return [{ address: "93.184.216.35", family: 4 }];
    if (hostname === "metadata.example.com") return [{ address: "169.254.169.254", family: 4 }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
}));

describe("validateConnectorOutboundUrl", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(validateConnectorOutboundUrl("ftp://example.com/file")).rejects.toThrow("only http(s) URLs are allowed");
    await expect(validateConnectorOutboundUrl("file:///etc/passwd")).rejects.toThrow("only http(s) URLs are allowed");
  });

  it("rejects embedded credentials", async () => {
    await expect(validateConnectorOutboundUrl("https://user:pass@example.com/")).rejects.toThrow("credentials");
  });

  it("rejects literal private, loopback and metadata addresses", async () => {
    for (const address of ["http://127.0.0.1:8000", "http://10.0.0.5", "http://192.168.1.1", "http://169.254.169.254/latest/meta-data", "http://172.16.4.4", "http://[::1]:8080"]) {
      await expect(validateConnectorOutboundUrl(address, { allowPrivate: false })).rejects.toThrow("private or reserved address");
    }
  });

  it("rejects private destinations by default", async () => {
    await expect(validateConnectorOutboundUrl("http://127.0.0.1:8000")).rejects.toThrow("private or reserved address");
  });

  it("accepts public literal addresses", async () => {
    await expect(validateConnectorOutboundUrl("https://93.184.216.34/")).resolves.toBeInstanceOf(URL);
  });

  it("allows private destinations when allowPrivate is set", async () => {
    await expect(validateConnectorOutboundUrl("http://127.0.0.1:9000", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });

  it("rejects hostnames resolving into private ranges (DNS rebinding baseline)", async () => {
    await expect(validateConnectorOutboundUrl("https://private.example.com/", { allowPrivate: false })).rejects.toThrow("private or reserved address");
    await expect(validateConnectorOutboundUrl("https://metadata.example.com/", { allowPrivate: false })).rejects.toThrow("private or reserved address");
  });

  it("rejects alternate IP encodings and special IPv6 ranges (SSRF variants)", async () => {
    for (const address of [
      "http://2130706433/", // 127.0.0.1 in decimal
      "http://0x7f000001/", // 127.0.0.1 in hex
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped IPv6 loopback
      "http://[fc00::1]/", // IPv6 ULA (fc00::/7)
      "http://[fd12:3456::1]/", // IPv6 ULA (fd00::/8)
      "http://[ff02::1]/", // IPv6 multicast
    ]) {
      await expect(validateConnectorOutboundUrl(address, { allowPrivate: false })).rejects.toThrow("private or reserved address");
    }
  });

  it("accepts hostnames resolving to public addresses", async () => {
    await expect(validateConnectorOutboundUrl("https://public.example.com/")).resolves.toBeInstanceOf(URL);
  });
});

describe("safeConnectorFetch", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/ok") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/redirect") {
        response.writeHead(302, { location: "/ok" });
        response.end();
        return;
      }
      if (url.pathname === "/redirect-loop") {
        response.writeHead(302, { location: "/redirect-loop" });
        response.end();
        return;
      }
      if (url.pathname === "/big") {
        response.writeHead(200, { "content-length": "1024" });
        response.end("x".repeat(1024));
        return;
      }
      if (url.pathname === "/chunked-big") {
        response.writeHead(200, { "content-type": "application/octet-stream", "transfer-encoding": "chunked" });
        response.write("x".repeat(2048));
        setTimeout(() => response.end("y".repeat(2048)), 10);
        return;
      }
      if (url.pathname === "/html") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html></html>");
        return;
      }
      if (url.pathname === "/private-hop") {
        response.writeHead(302, { location: "http://127.0.0.1:1/" });
        response.end();
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => {
          if (response.destroyed) return;
          try {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("late");
          } catch { /* client already gone */ }
        }, 800);
        return;
      }
      if (url.pathname === "/slow-body") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("first");
        setTimeout(() => {
          if (response.destroyed) return;
          try { response.end("late"); } catch { /* client already gone */ }
        }, 800);
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    vi.restoreAllMocks();
  });

  it("refuses private destinations when not explicitly allowed", async () => {
    await expect(safeConnectorFetch(`${baseUrl}/ok`, { allowPrivate: false })).rejects.toThrow("private or reserved address");
  });

  it("fetches and reads a small response when private is allowed", async () => {
    const response = await safeConnectorFetch(`${baseUrl}/ok`, { allowPrivate: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("follows redirects up to the cap and re-validates each hop", async () => {
    const response = await safeConnectorFetch(`${baseUrl}/redirect`, { allowPrivate: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects redirect loops beyond the hop cap", async () => {
    await expect(safeConnectorFetch(`${baseUrl}/redirect-loop`, { allowPrivate: true, maxRedirects: 2 })).rejects.toThrow("too many redirects");
  });

  it("rejects a redirect hop that escapes to a private address even when allowed", async () => {
    await expect(safeConnectorFetch(`${baseUrl}/private-hop`, { allowPrivate: true })).rejects.toThrow("private or reserved address");
  });

  it("strips sensitive headers on cross-origin redirect hops but keeps same-origin headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.hostname === "public.example.com") {
        return new Response(null, { status: 302, headers: { location: "http://other-public.example.com/echo" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await safeConnectorFetch("https://public.example.com/api", { headers: { authorization: "Bearer secret", "x-custom": "keep" } });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(firstHeaders?.authorization).toBe("Bearer secret");
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondHeaders?.authorization).toBeUndefined();
    expect(secondHeaders?.["x-custom"]).toBe("keep");
  });

  it("aborts when the total timeout elapses", async () => {
    await expect(safeConnectorFetch(`${baseUrl}/slow`, { allowPrivate: true, timeoutMs: 150 })).rejects.toThrow("timed out");
  });

  it("keeps the total timeout alive while the response body is streaming", async () => {
    const response = await safeConnectorFetch(`${baseUrl}/slow-body`, { allowPrivate: true, timeoutMs: 150 });
    await expect(response.text()).rejects.toThrow("timed out");
  });

  it("enforces content-length size caps before reading the body", async () => {
    await expect(safeConnectorFetch(`${baseUrl}/big`, { allowPrivate: true, maxResponseBytes: 256 })).rejects.toThrow("exceeds size limit");
  });

  it("enforces streaming size caps for chunked responses on read", async () => {
    const response = await safeConnectorFetch(`${baseUrl}/chunked-big`, { allowPrivate: true, maxResponseBytes: 1024 });
    await expect(response.text()).rejects.toThrow("exceeds size limit");
  });

  it("enforces the content-type allowlist", async () => {
    await expect(safeConnectorFetch(`${baseUrl}/html`, { allowPrivate: true, allowedContentTypes: ["application/json"] })).rejects.toThrow("unexpected content type");
    await expect(safeConnectorFetch(`${baseUrl}/ok`, { allowPrivate: true, allowedContentTypes: ["application/json"] })).resolves.toBeInstanceOf(Response);
  });

  it("requires an explicit environment opt-in for private access", async () => {
    const previous = process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS;
    process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS = "1";
    try {
      await expect(safeConnectorFetch(`${baseUrl}/ok`)).resolves.toBeInstanceOf(Response);
    } finally {
      if (previous === undefined) delete process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS;
      else process.env.PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS = previous;
    }
  });
});
