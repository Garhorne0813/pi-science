import { createServer as httpServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer, isIP, type Socket } from "node:net";
import { createResolvedAddressGuard, type ResolvedAddressGuardOptions } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";
import type { SandboxPolicy } from "./policy.js";

/** SRT leaves RFC1918 DNS answers enabled by default. Require an explicit
 * IP:port allowance for them, both on lookup and when rechecking open sockets. */
export function sandboxAddressGuard(network: SandboxPolicy["network"], resolver: Pick<ResolvedAddressGuardOptions, "resolve" | "localAddresses"> = {}) {
  return createResolvedAddressGuard({
    ...resolver,
    ...(network.mode === "allowlist" ? { allowedDomains: network.allowedDomains, deniedDomains: network.deniedDomains } : {}),
    deniedResolvedAddresses: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  });
}

/** TLS ClientHello parser. Fragmented records are assembled before parsing;
 * malformed, duplicate and encrypted-only server names are refused. A valid
 * hello without SNI returns an empty string, accepted only for explicit IP targets. */
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
      return name ?? "";
    } catch { return null; }
  }
  return undefined;
}

export function domainAllowed(host: string, port: number, network: SandboxPolicy["network"], transport: "http" | "https" = "https"): boolean {
  if (network.mode !== "allowlist") return false;
  host = host.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return false;
  const matches = (pattern: string) => {
    const [name, rawPort] = pattern.split(":");
    if (rawPort && Number(rawPort) !== port) return false;
    return name === "*" || name === host || name?.startsWith("*.") && host.endsWith(name.slice(1)) && host !== name.slice(2);
  };
  // Broad public HTTPS grants never implicitly authorize private literal endpoints.
  if (isIP(host) && !network.allowedDomains.some((pattern) => pattern.split(":")[0] === host && matches(pattern))) return false;
  return !network.deniedDomains.some(matches) && (network.allowedDomains.some(matches) || transport === "https" && (network.httpsOnlyDomains ?? []).some(matches));
}

/** Per-launch proxies: no shared mutable global policy and no host proxy inheritance.
 * SRT exposes only these ports (or their socat bridges) to the workload. */
export async function startSandboxNetwork(network: SandboxPolicy["network"], source?: () => Promise<SandboxPolicy["network"]>) {
  // Reads precede every new connection. Polling also tears down already-open
  // tunnels on revocation without killing the owning Python/R kernel.
  let refreshing: Promise<void> | undefined;
  const bindings = new Map<Socket, { host: string; port: number; transport: "http" | "https"; address?: string }>();
  let closed = false;
  const refresh = () => {
    if (!source || closed) return Promise.resolve();
    const next = (refreshing ?? Promise.resolve()).then(async () => {
      try { network = await source(); }
      catch { network = { mode: "none" }; } // Corrupt/unreadable state never widens access.
      const guard = sandboxAddressGuard(network);
      for (const [socket, target] of bindings) {
        if (!domainAllowed(target.host, target.port, network, target.transport)
          || target.address && !guard.permits(target.host, target.address, target.port)) socket.destroy();
      }
    });
    refreshing = next;
    void next.finally(() => { if (refreshing === next) refreshing = undefined; });
    return next;
  };
  await refresh();
  const timer = source ? setInterval(() => { if (!refreshing) void refresh(); }, 200) : undefined;
  timer?.unref();
  const lookupFor = (port: number) => sandboxAddressGuard(network).lookupFor(port);
  const sockets = new Set<Socket>();
  const watch = (socket: Socket) => { sockets.add(socket); socket.on("error", () => socket.destroy()); socket.on("close", () => { sockets.delete(socket); bindings.delete(socket); }); socket.setTimeout(120_000, () => socket.destroy()); };
  const tunnel = (client: Socket, host: string, port: number, initial: Buffer = Buffer.alloc(0)) => {
    let buffered: Buffer = initial; let upstream: Socket | undefined;
    client.setTimeout(10_000, () => client.destroy());
    const received = async (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 128 * 1024) { client.destroy(); return; }
      const sni = clientHelloServerName(buffered);
      if (sni === undefined) return;
      client.off("data", received); client.pause();
      if (!(isIP(host) && sni === "") && sni !== host.toLowerCase().replace(/\.$/, "")) { client.destroy(); return; }
      await refresh();
      if (client.destroyed || !domainAllowed(host, port, network)) { client.destroy(); return; }
      upstream = connect({ host, port, lookup: lookupFor(port), autoSelectFamily: false }); watch(upstream);
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream?.destroy());
      upstream.once("connect", () => {
        if (client.destroyed || !domainAllowed(host, port, network)) { upstream!.destroy(); return; }
        bindings.set(upstream!, { host, port, transport: "https", address: upstream!.remoteAddress });
        // This is a destination-bounded TCP tunnel after ClientHello inspection.
        // The proxy does not terminate TLS or verify the subsequent handshake.
        client.setTimeout(120_000); upstream!.write(buffered);
        upstream!.pipe(client); client.pipe(upstream!); client.resume();
      });
    };
    client.on("data", received);
    if (initial.length) { buffered = Buffer.alloc(0); void received(initial).catch(() => client.destroy()); }
  };
  const http = httpServer(async (req, res) => {
    try {
      await refresh();
      if (closed || req.socket.destroyed) return;
      const url = new URL(req.url ?? "");
      const port = Number(url.port || 80);
      if (url.protocol !== "http:" || url.username || url.password || !domainAllowed(url.hostname, port, network, "http")) { res.writeHead(403).end("Blocked by sandbox network policy"); return; }
      bindings.set(req.socket, { host: url.hostname, port, transport: "http" });
      const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
      for (const key of Object.keys(headers)) if (/^(?:connection|proxy-.*|forwarded|x-forwarded-.*|x-host|x-original-host|upgrade|http2-settings|te|keep-alive|trailer)$/i.test(key)) delete headers[key];
      const upstream = httpRequest({ hostname: url.hostname, port, method: req.method, path: url.pathname + url.search, headers, lookup: lookupFor(port), timeout: 30_000 }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.on("socket", (socket) => {
        watch(socket);
        bindings.set(socket, { host: url.hostname, port, transport: "http", address: socket.remoteAddress });
        socket.once("connect", () => { const target = bindings.get(socket); if (target) target.address = socket.remoteAddress; });
        socket.once("close", () => { if (!res.writableEnded) res.destroy(); });
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502).end("Sandbox upstream connection failed"); else res.destroy(); });
      res.once("close", () => upstream.destroy()); req.pipe(upstream);
    } catch { res.writeHead(400).end("Invalid proxy request"); }
  });
  http.on("connection", watch);
  http.on("connect", async (req, rawClient, head) => {
    await refresh();
    const client = rawClient as Socket;
    if (closed || client.destroyed) return;
    const match = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(req.url ?? "");
    if (!match || !domainAllowed(match[1]!, Number(match[2]), network)) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nBlocked by sandbox network policy"); return; }
    bindings.set(client, { host: match[1]!, port: Number(match[2]), transport: "https" });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tunnel(client, match[1]!, Number(match[2]), head);
  });
  const socks = createServer((client) => {
    watch(client); let buffer: Buffer = Buffer.alloc(0), greeted = false;
    let processing = false;
    const received = async (chunk: Buffer) => {
      if (processing) { client.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) { client.destroy(); return; }
      if (!greeted) {
        if (buffer.length < 2) return;
        const size = 2 + buffer[1]!; if (buffer.length < size) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, size).includes(0)) { client.end(Buffer.from([5, 255])); return; }
        client.write(Buffer.from([5, 0])); buffer = buffer.subarray(size); greeted = true;
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || ![1, 3].includes(buffer[3]!)) { client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const size = buffer[3] === 1 ? 8 : 5 + buffer[4]!; if (buffer.length < size + 2) return;
      processing = true; client.pause(); await refresh();
      if (client.destroyed) return;
      const host = buffer[3] === 1 ? [...buffer.subarray(4, 8)].join(".") : buffer.subarray(5, size).toString("ascii"), port = buffer.readUInt16BE(size);
      if (!domainAllowed(host, port, network)) { client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      bindings.set(client, { host, port, transport: "https" });
      client.off("data", received); client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      tunnel(client, host, port, buffer.subarray(size + 2)); client.resume();
    };
    client.on("data", received);
  });
  http.maxConnections = socks.maxConnections = 256;
  const listen = (server: typeof http | typeof socks) => new Promise<number>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const close = async () => {
    closed = true;
    if (timer) clearInterval(timer);
    await refreshing;
    for (const socket of sockets) socket.destroy();
    await Promise.all([http, socks].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  try { const httpPort = await listen(http), socksPort = await listen(socks); return { httpPort, socksPort, close }; }
  catch (error) { await close(); throw error; }
}
