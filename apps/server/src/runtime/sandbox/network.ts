import { createServer as httpServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import type { SandboxPolicy } from "./policy.js";

/** TLS ClientHello parser. Fragmented records are assembled before parsing;
 * malformed, absent, duplicate and encrypted-only server names are refused. */
export function clientHelloServerName(records: Buffer): string | null | undefined {
  const chunks: Buffer[] = []; let offset = 0;
  while (offset < records.length) {
    if (records.length - offset < 5) return undefined;
    if (records[offset] !== 22 || records[offset + 1] !== 3) return null;
    const size = records.readUInt16BE(offset + 3);
    if (size > 18432) return null;
    if (offset + 5 + size > records.length) return undefined;
    chunks.push(records.subarray(offset + 5, offset + 5 + size)); offset += 5 + size;
    const hello = Buffer.concat(chunks);
    if (hello.length < 4) continue;
    if (hello[0] !== 1) return null;
    const length = hello.readUIntBE(1, 3);
    if (length > 65536) return null;
    if (hello.length < length + 4) continue;
    try {
      const end = length + 4;
      let position = 38;
      position += 1 + hello.readUInt8(position);
      position += 2 + hello.readUInt16BE(position);
      position += 1 + hello.readUInt8(position);
      const extensionEnd = position + 2 + hello.readUInt16BE(position); position += 2;
      if (extensionEnd !== end) return null;
      let name: string | null = null;
      while (position < end) {
        const kind = hello.readUInt16BE(position), size = hello.readUInt16BE(position + 2); position += 4;
        if (position + size > end) return null;
        if (kind === 0xfe0d) return null; // Encrypted ClientHello hides the authority being checked.
        if (kind === 0) {
          if (name || size < 5 || hello.readUInt16BE(position) !== size - 2 || hello[position + 2] !== 0 || hello.readUInt16BE(position + 3) !== size - 5) return null;
          const bytes = hello.subarray(position + 5, position + size);
          if (!/^[a-zA-Z0-9.-]+$/.test(bytes.toString("ascii")) || bytes.some((byte) => byte > 127)) return null;
          name = bytes.toString("ascii").toLowerCase();
        }
        position += size;
      }
      return name;
    } catch { return null; }
  }
  return undefined;
}

export function domainAllowed(host: string, port: number, network: SandboxPolicy["network"]): boolean {
  if (network.mode !== "allowlist") return false;
  host = host.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return false;
  const matches = (pattern: string) => {
    const [name, rawPort] = pattern.split(":");
    if (rawPort && Number(rawPort) !== port) return false;
    return name === host || name?.startsWith("*.") && host.endsWith(name.slice(1)) && host !== name.slice(2);
  };
  return !network.deniedDomains.some(matches) && network.allowedDomains.some(matches);
}

/** Per-launch proxies: no shared mutable global policy and no host proxy inheritance.
 * SRT exposes only these ports (or their socat bridges) to the workload. */
export async function startSandboxNetwork(network: SandboxPolicy["network"]) {
  const guard = createResolvedAddressGuard();
  const sockets = new Set<Socket>();
  const watch = (socket: Socket) => { sockets.add(socket); socket.on("error", () => socket.destroy()); socket.on("close", () => sockets.delete(socket)); socket.setTimeout(120_000, () => socket.destroy()); };
  const tunnel = (client: Socket, host: string, port: number, initial: Buffer = Buffer.alloc(0)) => {
    let buffered: Buffer = initial; let upstream: Socket | undefined;
    client.setTimeout(10_000, () => client.destroy());
    const received = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 128 * 1024) { client.destroy(); return; }
      const sni = clientHelloServerName(buffered);
      if (sni === undefined) return;
      client.off("data", received); client.pause();
      if (sni !== host.toLowerCase().replace(/\.$/, "")) { client.destroy(); return; }
      upstream = connect({ host, port, lookup: guard.lookupFor(port) }); watch(upstream);
      upstream.once("error", () => client.destroy());
      client.once("close", () => upstream?.destroy());
      upstream.once("connect", () => {
        if (client.destroyed) { upstream!.destroy(); return; }
        client.setTimeout(120_000); upstream!.write(buffered);
        upstream!.pipe(client); client.pipe(upstream!); client.resume();
      });
    };
    client.on("data", received);
    if (initial.length) { buffered = Buffer.alloc(0); received(initial); }
  };
  const http = httpServer((req, res) => {
    try {
      const url = new URL(req.url ?? "");
      const port = Number(url.port || 80);
      if (url.protocol !== "http:" || url.username || url.password || !domainAllowed(url.hostname, port, network)) { res.writeHead(403).end("Blocked by sandbox network policy"); return; }
      const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
      for (const key of Object.keys(headers)) if (/^(?:connection|proxy-.*|forwarded|x-forwarded-.*|x-host|x-original-host|upgrade|http2-settings|te|keep-alive|trailer)$/i.test(key)) delete headers[key];
      const upstream = httpRequest({ hostname: url.hostname, port, method: req.method, path: url.pathname + url.search, headers, lookup: guard.lookupFor(port), timeout: 30_000 }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.on("socket", watch); upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("Sandbox upstream connection failed"); else res.destroy(); });
      res.once("close", () => upstream.destroy()); req.pipe(upstream);
    } catch { res.writeHead(400).end("Invalid proxy request"); }
  });
  http.on("connection", watch);
  http.on("connect", (req, rawClient, head) => {
    const client = rawClient as Socket;
    const match = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(req.url ?? "");
    if (!match || !domainAllowed(match[1]!, Number(match[2]), network)) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nBlocked by sandbox network policy"); return; }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tunnel(client, match[1]!, Number(match[2]), head);
  });
  const socks = createServer((client) => {
    watch(client); let buffer: Buffer = Buffer.alloc(0), greeted = false;
    const received = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) { client.destroy(); return; }
      if (!greeted) {
        if (buffer.length < 2) return;
        const size = 2 + buffer[1]!; if (buffer.length < size) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, size).includes(0)) { client.end(Buffer.from([5, 255])); return; }
        client.write(Buffer.from([5, 0])); buffer = buffer.subarray(size); greeted = true;
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || buffer[3] !== 3) { client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const size = 5 + buffer[4]!; if (buffer.length < size + 2) return;
      const host = buffer.subarray(5, size).toString("ascii"), port = buffer.readUInt16BE(size);
      if (!domainAllowed(host, port, network)) { client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      client.off("data", received); client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      tunnel(client, host, port, buffer.subarray(size + 2));
    };
    client.on("data", received);
  });
  http.maxConnections = socks.maxConnections = 256;
  const listen = (server: typeof http | typeof socks) => new Promise<number>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([http, socks].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  try { const httpPort = await listen(http), socksPort = await listen(socks); return { httpPort, socksPort, close }; }
  catch (error) { await close(); throw error; }
}
