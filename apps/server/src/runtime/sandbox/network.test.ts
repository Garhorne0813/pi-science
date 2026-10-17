import { connect } from "node:net";
import { afterEach, expect, it } from "vitest";
import { clientHelloServerName, domainAllowed, startSandboxNetwork } from "./network.js";

function hello(host: string) {
  const name = Buffer.from(host); const sni = Buffer.alloc(9 + name.length);
  sni.writeUInt16BE(0, 0); sni.writeUInt16BE(name.length + 5, 2); sni.writeUInt16BE(name.length + 3, 4); sni[6] = 0; sni.writeUInt16BE(name.length, 7); name.copy(sni, 9);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), Buffer.from([sni.length >> 8, sni.length & 255]), sni]);
  const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([22, 3, 1, handshake.length >> 8, handshake.length & 255]), handshake]);
}
it("parses actual ClientHello shape and waits for fragmented records without accepting absent/malformed SNI", () => {
  const data = hello("example.com");
  expect(clientHelloServerName(data)).toBe("example.com");
  for (let i = 0; i < data.length; i++) expect(clientHelloServerName(data.subarray(0, i))).toBeUndefined();
  const handshake = data.subarray(5), split = 22;
  const record = (bytes: Buffer) => Buffer.concat([Buffer.from([22, 3, 3, bytes.length >> 8, bytes.length & 255]), bytes]);
  expect(clientHelloServerName(Buffer.concat([record(handshake.subarray(0, split)), record(handshake.subarray(split))]))).toBe("example.com");
  expect(clientHelloServerName(Buffer.from("GET / HTTP/1.1\r\n"))).toBeNull();
  const oversized = Buffer.from(data); oversized.writeUInt16BE(65535, 3); expect(clientHelloServerName(oversized)).toBeNull();
});
it("enforces deny precedence, exact hosts, wildcard boundaries and destination ports", () => {
  const network = { mode: "allowlist" as const, allowedDomains: ["*.example.com:443"], deniedDomains: ["blocked.example.com"] };
  expect(domainAllowed("api.example.com", 443, network)).toBe(true);
  for (const host of ["blocked.example.com", "example.com", "evilexample.com", "api.example.com.evil.test"]) expect(domainAllowed(host, 443, network)).toBe(false);
  expect(domainAllowed("api.example.com", 80, network)).toBe(false); expect(domainAllowed("api.example.com", 443, { mode: "none" })).toBe(false);
});
let proxy: Awaited<ReturnType<typeof startSandboxNetwork>> | undefined;
afterEach(async () => { await proxy?.close(); proxy = undefined; });
const exchange = (port: number, data: string | Buffer) => new Promise<Buffer>((resolve, reject) => {
  const socket = connect(port, "127.0.0.1"); const output: Buffer[] = [];
  socket.setTimeout(2000, () => socket.destroy(new Error("proxy test timeout")));
  socket.on("error", reject); socket.on("data", (chunk) => { output.push(chunk); socket.end(); }); socket.on("close", () => resolve(Buffer.concat(output))); socket.once("connect", () => socket.write(data));
});
it("blocks unknown HTTP/CONNECT destinations and rejects SOCKS authentication it does not implement", async () => {
  proxy = await startSandboxNetwork({ mode: "none" });
  expect((await exchange(proxy.httpPort, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n")).toString()).toContain("403");
  expect((await exchange(proxy.httpPort, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n")).toString()).toContain("403");
  expect(await exchange(proxy.socksPort, Buffer.from([5, 1, 2]))).toEqual(Buffer.from([5, 255]));
});
it("refuses domain fronting before any upstream connection", async () => {
  proxy = await startSandboxNetwork({ mode: "allowlist", allowedDomains: ["example.com:443"], deniedDomains: [] });
  await new Promise<void>((resolve, reject) => {
    const socket = connect(proxy!.httpPort, "127.0.0.1"); let ready = false;
    socket.setTimeout(2000, () => socket.destroy(new Error("SNI refusal timeout")));
    socket.on("error", reject); socket.on("close", () => ready ? resolve() : reject(new Error("CONNECT not accepted")));
    socket.on("data", (chunk) => { if (!ready) { ready = chunk.toString().includes("200"); socket.write(hello("other.example.com")); } });
    socket.once("connect", () => socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n"));
  });
});
