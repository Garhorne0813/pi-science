import { connect, createServer as tcpServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import {
  clientHelloServerName,
  domainAllowed,
  sandboxAddressGuard,
  startSandboxNetwork,
} from "./network.js";
import { grantedNetwork, privateNetworkTarget, type NetworkGrants } from "./network-grant-state.js";

function hello(host?: string) {
  const name = Buffer.from(host ?? "");
  let sni = Buffer.alloc(9 + name.length);
  sni.writeUInt16BE(0, 0);
  sni.writeUInt16BE(name.length + 5, 2);
  sni.writeUInt16BE(name.length + 3, 4);
  sni[6] = 0;
  sni.writeUInt16BE(name.length, 7);
  name.copy(sni, 9);
  if (host === undefined) sni = Buffer.alloc(0);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32),
    Buffer.from([0, 0, 2, 0x13, 1, 1, 0]),
    Buffer.from([sni.length >> 8, sni.length & 255]),
    sni,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([
    Buffer.from([22, 3, 1, handshake.length >> 8, handshake.length & 255]),
    handshake,
  ]);
}
it("parses actual ClientHello shape and waits for fragmented records without accepting absent/malformed SNI", () => {
  const data = hello("example.com");
  expect(clientHelloServerName(data)).toBe("example.com");
  for (let i = 0; i < data.length; i++)
    expect(clientHelloServerName(data.subarray(0, i))).toBeUndefined();
  const handshake = data.subarray(5),
    split = 22;
  const record = (bytes: Buffer) =>
    Buffer.concat([Buffer.from([22, 3, 3, bytes.length >> 8, bytes.length & 255]), bytes]);
  expect(
    clientHelloServerName(
      Buffer.concat([record(handshake.subarray(0, split)), record(handshake.subarray(split))]),
    ),
  ).toBe("example.com");
  expect(clientHelloServerName(Buffer.from("GET / HTTP/1.1\r\n"))).toBeNull();
  const oversized = Buffer.from(data);
  oversized.writeUInt16BE(65535, 3);
  expect(clientHelloServerName(oversized)).toBeNull();
});
it("enforces deny precedence, exact hosts, wildcard boundaries and destination ports", () => {
  const network = {
    mode: "allowlist" as const,
    allowedDomains: ["*.example.com:443"],
    deniedDomains: ["blocked.example.com"],
  };
  expect(domainAllowed("api.example.com", 443, network)).toBe(true);
  for (const host of [
    "blocked.example.com",
    "example.com",
    "evilexample.com",
    "api.example.com.evil.test",
  ])
    expect(domainAllowed(host, 443, network)).toBe(false);
  expect(domainAllowed("api.example.com", 80, network)).toBe(false);
  expect(domainAllowed("api.example.com", 443, { mode: "none" })).toBe(false);
});
let proxy: Awaited<ReturnType<typeof startSandboxNetwork>> | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
});
const exchange = (port: number, data: string | Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const output: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error("proxy test timeout")));
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      output.push(chunk);
      socket.destroy();
    });
    socket.on("close", () => resolve(Buffer.concat(output)));
    socket.once("connect", () => socket.write(data));
  });
it("blocks unknown HTTP/CONNECT destinations and rejects SOCKS authentication it does not implement", async () => {
  proxy = await startSandboxNetwork({ mode: "none" });
  expect(
    (
      await exchange(
        proxy.httpPort,
        "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
  expect(
    (
      await exchange(
        proxy.httpPort,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
  expect(await exchange(proxy.socksPort, Buffer.from([5, 1, 2]))).toEqual(Buffer.from([5, 255]));
});
it.each(["analysis", "mcp"] as const)(
  "refuses plaintext HTTP on port 443 authorized only by a %s user grant",
  async (profile) => {
    const state: NetworkGrants = {
      schemaVersion: 1,
      targetRevisions: {},
      revision: 1,
      rules: [
        {
          profile,
          domain: "api.example.org",
          decision: "allow",
          source: "settings",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const network = grantedNetwork({ mode: "none" }, state, profile);
    proxy = await startSandboxNetwork(network);
    expect(
      (
        await exchange(
          proxy.httpPort,
          "GET http://api.example.org:443/ HTTP/1.1\r\nHost: api.example.org:443\r\nConnection: close\r\n\r\n",
        )
      ).toString(),
    ).toContain("403");
    expect(
      (
        await exchange(
          proxy.httpPort,
          "CONNECT api.example.org:443 HTTP/1.1\r\nHost: api.example.org:443\r\n\r\n",
        )
      ).toString(),
    ).toContain("200 Connection Established");
    expect(domainAllowed("api.example.org", 443, network, "http")).toBe(false);
    const operatorNetwork = grantedNetwork(
      { mode: "allowlist", allowedDomains: ["api.example.org:443"], deniedDomains: [] },
      state,
      profile,
    );
    expect(domainAllowed("api.example.org", 443, operatorNetwork, "http")).toBe(true);
    expect(
      domainAllowed(
        "api.example.org",
        443,
        grantedNetwork(
          {
            mode: "allowlist",
            allowedDomains: ["api.example.org:443"],
            deniedDomains: ["api.example.org"],
          },
          state,
          profile,
        ),
        "http",
      ),
    ).toBe(false);
  },
);
it("refuses domain fronting before any upstream connection", async () => {
  proxy = await startSandboxNetwork({
    mode: "allowlist",
    allowedDomains: ["example.com:443"],
    deniedDomains: [],
  });
  await new Promise<void>((resolve, reject) => {
    const socket = connect(proxy!.httpPort, "127.0.0.1");
    let ready = false;
    socket.setTimeout(2000, () => socket.destroy(new Error("SNI refusal timeout")));
    socket.on("error", reject);
    socket.on("close", () => (ready ? resolve() : reject(new Error("CONNECT not accepted"))));
    socket.on("data", (chunk) => {
      if (!ready) {
        ready = chunk.toString().includes("200");
        socket.write(hello("other.example.com"));
      }
    });
    socket.once("connect", () =>
      socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n"),
    );
  });
});

it("rechecks dynamic decisions for new connections and closes an existing tunnel when access is revoked", async () => {
  let allowed = false;
  proxy = await startSandboxNetwork({ mode: "none" }, async () => ({
    mode: "allowlist",
    allowedDomains: allowed ? ["example.com:443"] : [],
    deniedDomains: [],
  }));
  expect(
    (
      await exchange(
        proxy.httpPort,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
  allowed = true;
  const client = connect(proxy.httpPort, "127.0.0.1");
  const closed = new Promise<void>((resolve, reject) => {
    client.once("close", () => resolve());
    client.once("error", reject);
  });
  client.setTimeout(2000, () => client.destroy(new Error("revocation timeout")));
  await new Promise<void>((resolve, reject) => {
    client.once("error", reject);
    client.once("data", (chunk) => {
      expect(chunk.toString()).toContain("200 Connection Established");
      resolve();
    });
    client.once("connect", () =>
      client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n"),
    );
  });
  allowed = false;
  await closed;
  expect(
    (
      await exchange(
        proxy.httpPort,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
});

it("closes connections and refuses new requests when the dynamic permission source becomes unreadable", async () => {
  proxy = await startSandboxNetwork(
    { mode: "allowlist", allowedDomains: ["example.com:443"], deniedDomains: [] },
    async () => {
      throw new Error("corrupt ledger");
    },
  );
  expect(
    (
      await exchange(
        proxy.httpPort,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
});

it("requires an explicit IP and port even with broad public HTTPS access", () => {
  const network = {
    mode: "allowlist" as const,
    allowedDomains: [],
    httpsOnlyDomains: ["*:443"],
    deniedDomains: [],
  };
  expect(domainAllowed("api.example.org", 443, network)).toBe(true);
  expect(domainAllowed("192.168.1.10", 443, network)).toBe(false);
  expect(
    domainAllowed("192.168.1.10", 443, { ...network, allowedDomains: ["192.168.1.10:443"] }),
  ).toBe(true);
});
const privateHost = Object.values(networkInterfaces())
  .flat()
  .find((address) => address?.family === "IPv4" && privateNetworkTarget(address.address))?.address;
it.skipIf(!privateHost)(
  "forwards HTTP to an approved private endpoint and applies revocation to subsequent requests",
  async () => {
    const target = httpServer((_request, response) => response.end("private-service-ok"));
    target.listen(0, privateHost!);
    await once(target, "listening");
    const port = (target.address() as { port: number }).port;
    let allowed = true;
    try {
      proxy = await startSandboxNetwork({ mode: "none" }, async () => ({
        mode: "allowlist",
        allowedDomains: allowed ? [`${privateHost}:${port}`] : [],
        deniedDomains: [],
      }));
      const request = `GET http://${privateHost}:${port}/ HTTP/1.1\r\nHost: ${privateHost}:${port}\r\nConnection: close\r\n\r\n`;
      expect((await exchange(proxy.httpPort, request)).toString()).toContain("private-service-ok");
      allowed = false;
      expect((await exchange(proxy.httpPort, request)).toString()).toContain("403");
    } finally {
      await proxy?.close();
      proxy = undefined;
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  },
);
it.skipIf(!privateHost).each(["CONNECT", "SOCKS"])(
  "opens a destination-bounded TCP tunnel after ClientHello inspection through %s and revokes it",
  async (transport) => {
    const received: Buffer[] = [];
    let allowed = true;
    const target = tcpServer((socket) =>
      socket.once("data", (data) => {
        received.push(data);
        socket.write("private-tcp-response");
        allowed = false;
      }),
    );
    target.listen(0, privateHost!);
    await once(target, "listening");
    const port = (target.address() as { port: number }).port;
    try {
      proxy = await startSandboxNetwork({ mode: "none" }, async () => ({
        mode: "allowlist",
        allowedDomains: allowed ? [`${privateHost}:${port}`] : [],
        deniedDomains: [],
      }));
      const data = Buffer.concat([hello(), Buffer.from("plain TCP payload after ClientHello")]);
      expect(clientHelloServerName(data)).toBe("");
      const response = await new Promise<Buffer>((resolve, reject) => {
        const client = connect(
          transport === "CONNECT" ? proxy!.httpPort : proxy!.socksPort,
          "127.0.0.1",
        );
        let buffer = Buffer.alloc(0),
          ready = false;
        client.setTimeout(2000, () => client.destroy(new Error("private tunnel timeout")));
        client.on("error", reject);
        client.on("close", () => resolve(buffer));
        client.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (
            !ready &&
            (transport === "CONNECT"
              ? buffer.includes("200 Connection Established")
              : buffer.length >= 12)
          ) {
            ready = true;
            client.write(data);
          }
        });
        client.once("connect", () => {
          if (transport === "CONNECT")
            client.write(
              `CONNECT ${privateHost}:${port} HTTP/1.1\r\nHost: ${privateHost}:${port}\r\n\r\n`,
            );
          else {
            const bytes = Buffer.from([
              5,
              1,
              0,
              5,
              1,
              0,
              1,
              ...privateHost!.split(".").map(Number),
              port >> 8,
              port & 255,
            ]);
            client.write(bytes);
          }
        });
      });
      expect(response.toString()).toContain("private-tcp-response");
      expect(received).toEqual([data]);
    } finally {
      await proxy?.close();
      proxy = undefined;
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  },
);

it.each(["10.20.30.40", "172.20.1.50", "192.168.1.50"])(
  "requires exact IP:port approval for an allowed hostname resolving to %s",
  async (address) => {
    const hostname = "api.example.org";
    const base = {
      mode: "allowlist" as const,
      allowedDomains: [`${hostname}:443`],
      deniedDomains: [] as string[],
    };
    // Remove host-interface denials so this specifically exercises RFC1918 policy.
    const resolver = {
      localAddresses: () => [],
      resolve: (
        _host: string,
        _options: unknown,
        callback: (
          error: NodeJS.ErrnoException | null,
          addresses: { address: string; family: number }[],
        ) => void,
      ) => callback(null, [{ address, family: 4 }]),
    };
    const lookup = (network: typeof base) =>
      new Promise((resolve, reject) => {
        sandboxAddressGuard(network, resolver).lookupFor(443)(
          hostname,
          { all: true },
          (error, addresses) => (error ? reject(error) : resolve(addresses)),
        );
      });
    expect(domainAllowed(hostname, 443, base)).toBe(true);
    await expect(lookup(base)).rejects.toMatchObject({ code: "ERR_SRT_RESOLVED_ADDRESS_DENIED" });
    await expect(
      lookup({ ...base, allowedDomains: [...base.allowedDomains, `${address}:8443`] }),
    ).rejects.toMatchObject({ code: "ERR_SRT_RESOLVED_ADDRESS_DENIED" });
    const approved = { ...base, allowedDomains: [...base.allowedDomains, `${address}:443`] };
    await expect(lookup(approved)).resolves.toEqual([{ address, family: 4 }]);
    await expect(lookup({ ...approved, deniedDomains: [address] })).rejects.toMatchObject({
      code: "ERR_SRT_RESOLVED_ADDRESS_DENIED",
    });
    // The same guard drives active-socket revocation after the IP grant disappears.
    expect(sandboxAddressGuard(approved, resolver).permits(hostname, address, 443)).toBe(true);
    expect(sandboxAddressGuard(base, resolver).permits(hostname, address, 443)).toBe(false);
    await expect(lookup(base)).rejects.toMatchObject({ code: "ERR_SRT_RESOLVED_ADDRESS_DENIED" });
  },
);

it.skipIf(!privateHost)("refuses bare plaintext before opening a private IP tunnel", async () => {
  let connections = 0;
  const target = tcpServer((socket) => {
    connections++;
    socket.destroy();
  });
  target.listen(0, privateHost!);
  await once(target, "listening");
  const port = (target.address() as { port: number }).port;
  try {
    proxy = await startSandboxNetwork({
      mode: "allowlist",
      allowedDomains: [`${privateHost}:${port}`],
      deniedDomains: [],
    });
    await new Promise<void>((resolve, reject) => {
      const client = connect(proxy!.httpPort, "127.0.0.1");
      let ready = false;
      client.setTimeout(2000, () => client.destroy(new Error("plaintext refusal timeout")));
      client.once("error", reject);
      client.once("close", () =>
        ready ? resolve() : reject(new Error("CONNECT was not accepted")),
      );
      client.once("data", (response) => {
        ready = response.toString().includes("200 Connection Established");
        client.write("GET /raw HTTP/1.1\r\n\r\n");
      });
      client.once("connect", () =>
        client.write(
          `CONNECT ${privateHost}:${port} HTTP/1.1\r\nHost: ${privateHost}:${port}\r\n\r\n`,
        ),
      );
    });
    expect(connections).toBe(0);
  } finally {
    await proxy?.close();
    proxy = undefined;
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

it("waits for host approval and continues the original CONNECT without a second model/tool call", async () => {
  let allowed = false,
    release!: () => void;
  const decision = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: unknown[] = [];
  proxy = await startSandboxNetwork(
    { mode: "none" },
    async () => ({
      mode: "allowlist",
      allowedDomains: allowed ? ["example.com:443"] : [],
      deniedDomains: [],
    }),
    async (host, port, transport) => {
      requests.push({ host, port, transport });
      await decision;
      allowed = true;
      return true;
    },
  );
  const pending = exchange(
    proxy.httpPort,
    "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
  );
  const { vi } = await import("vitest");
  await vi.waitFor(() =>
    expect(requests).toEqual([{ host: "example.com", port: 443, transport: "https" }]),
  );
  release();
  expect((await pending).toString()).toContain("200 Connection Established");
});

it("never asks the host to override explicit denials or unsupported public HTTP", async () => {
  const { vi } = await import("vitest");
  const approve = vi.fn(async () => true);
  proxy = await startSandboxNetwork(
    { mode: "allowlist", allowedDomains: [], deniedDomains: ["example.com"] },
    undefined,
    approve,
  );
  expect(
    (
      await exchange(
        proxy.httpPort,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
  expect(
    (
      await exchange(
        proxy.httpPort,
        "GET http://other.example/ HTTP/1.1\r\nHost: other.example\r\n\r\n",
      )
    ).toString(),
  ).toContain("403");
  expect(approve).not.toHaveBeenCalled();
});

it("refuses a declined or stale approval instead of trusting the approval response alone", async () => {
  for (const granted of [false, true]) {
    proxy = await startSandboxNetwork(
      { mode: "none" },
      async () => ({ mode: "none" }),
      async () => granted,
    );
    expect(
      (
        await exchange(
          proxy.httpPort,
          "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
        )
      ).toString(),
    ).toContain("403");
    await proxy.close();
    proxy = undefined;
  }
});

it("cancels the pending approval when the original connection closes", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled!: () => void;
  const aborted = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  proxy = await startSandboxNetwork(
    { mode: "none" },
    undefined,
    async (_host, _port, _transport, signal) => {
      started();
      return new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            resolve(false);
          },
          { once: true },
        ),
      );
    },
  );
  const client = connect(proxy.httpPort, "127.0.0.1");
  client.once("connect", () =>
    client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n"),
  );
  await ready;
  client.destroy();
  await aborted;
});
