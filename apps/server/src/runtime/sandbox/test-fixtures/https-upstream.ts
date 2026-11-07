import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { privateNetworkTarget } from "../network-grant-state.js";

/** Real TLS endpoints on an explicitly grantable private interface. Only the
 * public test CA enters the workload; private keys stay outside its read grant. */
export async function httpsUpstream(control: string, workspace: string) {
  const host = Object.values(networkInterfaces())
    .flat()
    .find(
      (address) => address?.family === "IPv4" && privateNetworkTarget(address.address),
    )?.address;
  if (!host)
    throw new Error(
      "HTTPS acceptance requires a private IPv4 interface for explicit endpoint grants",
    );
  const key = join(control, "server-key.pem"),
    cert = join(control, "server-cert.pem"),
    ca = join(workspace, "fixture-ca.txt"),
    config = join(control, "openssl.cnf");
  // A config file works with macOS LibreSSL as well as Linux OpenSSL; req's
  // -addext option is not available in every supported platform executable.
  await writeFile(
    config,
    `[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=server\n[subject]\nCN=pi-science-acceptance\n[server]\nsubjectAltName=IP:${host}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`,
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-config",
      config,
    ],
    { stdio: "ignore" },
  );
  const certificate = await readFile(cert, "utf8");
  await writeFile(ca, certificate);
  const tls = { key: await readFile(key), cert: certificate };
  const sockets = new Set<Duplex>();
  const servers = [0, 1].map(() => {
    const server = createServer(tls, (_request, response) => response.end("sandbox-fixture-ok\n"));
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", (_error, socket) => socket.destroy());
    return server;
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  };
  try {
    const ports: number[] = [];
    for (const server of servers)
      ports.push(
        await new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, host, () => resolve((server.address() as { port: number }).port));
        }),
      );
    return {
      host,
      port: ports[0]!,
      endpoint: `${host}:${ports[0]}`,
      url: `https://${host}:${ports[0]}/`,
      deniedEndpoint: `${host}:${ports[1]}`,
      deniedUrl: `https://${host}:${ports[1]}/`,
      ca,
      certificate,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
