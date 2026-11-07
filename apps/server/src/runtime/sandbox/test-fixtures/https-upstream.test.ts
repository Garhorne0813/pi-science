import { get } from "node:https";
import { request } from "node:http";
import { checkServerIdentity, connect } from "node:tls";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { httpsUpstream } from "./https-upstream.js";
import { startSandboxNetwork } from "../network.js";

let root: string | undefined;
let upstream: Awaited<ReturnType<typeof httpsUpstream>> | undefined;
let proxy: Awaited<ReturnType<typeof startSandboxNetwork>> | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await upstream?.close();
  upstream = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
function read(url: string, ca?: string) {
  return new Promise<string>((resolve, reject) => {
    const request = get(url, { ca, agent: false, rejectUnauthorized: true }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("fixture request timed out")));
  });
}

async function fixture() {
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-tls-fixture-")));
  const control = join(root, "control"),
    workspace = join(root, "workspace");
  await mkdir(control);
  await mkdir(workspace);
  upstream = await httpsUpstream(control, workspace);
  return upstream;
}

function throughProxy(port: number, host: string, endpoint: string, ca?: string) {
  return new Promise<string>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: endpoint,
      agent: false,
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("proxy fixture timed out")));
    req.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(
          Object.assign(new Error("proxy refused endpoint"), { statusCode: response.statusCode }),
        );
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = connect({
        socket,
        ca,
        rejectUnauthorized: true,
        checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
      });
      let body = "";
      secure.on("error", reject);
      secure.setTimeout(3000, () => secure.destroy(new Error("TLS fixture timed out")));
      secure.on("data", (chunk) => (body += chunk));
      secure.once("end", () => resolve(body));
      secure.once("secureConnect", () =>
        secure.write(`GET / HTTP/1.1\r\nHost: ${endpoint}\r\nConnection: close\r\n\r\n`),
      );
    });
    req.end();
  });
}

// Only POSIX sandbox acceptance uses this OpenSSL/LibreSSL fixture.
it.skipIf(!["linux", "darwin"].includes(process.platform))(
  "provides two live endpoints with verified TLS and rejects the untrusted test CA",
  async () => {
    const target = await fixture();
    await expect(read(target.url)).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(await read(target.url, target.certificate)).toBe("sandbox-fixture-ok\n");
    expect(await read(target.deniedUrl, target.certificate)).toBe("sandbox-fixture-ok\n");
  },
);

it.skipIf(!["linux", "darwin"].includes(process.platform))(
  "verifies TLS through the actual proxy and enforces exact endpoint grants and revocation",
  async () => {
    const target = await fixture();
    let allowed = false;
    proxy = await startSandboxNetwork({ mode: "none" }, async () => ({
      mode: "allowlist",
      allowedDomains: allowed ? [target.endpoint] : [],
      deniedDomains: [],
    }));
    const readTarget = (endpoint = target.endpoint, ca: string | undefined = target.certificate) =>
      throughProxy(proxy!.httpPort, target.host, endpoint, ca);
    await expect(readTarget()).rejects.toMatchObject({ statusCode: 403 });
    allowed = true;
    await expect(throughProxy(proxy.httpPort, target.host, target.endpoint)).rejects.toMatchObject({
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(await readTarget()).toContain("sandbox-fixture-ok");
    await expect(readTarget(target.deniedEndpoint)).rejects.toMatchObject({ statusCode: 403 });
    allowed = false;
    await expect(readTarget()).rejects.toMatchObject({ statusCode: 403 });
  },
);
