/** Trusted watchdog. This file and its manifest are never writable by sandbox code. */
import { createHash } from "node:crypto";
import type { NetworkGrantProfile } from "./network-grant-state.js";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const [manifestPath, ...shellArgs] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath!, "utf8")) as {
  networkPolicy?: import("./policy.js").SandboxPolicy["network"];
  cli: string;
  settings: string;
  argv: string[];
  env: Record<string, string>;
  timeoutSeconds: number;
  kernelBridge?: string;
  supervisor?: string;
  lifecycleTag?: string;
  deniedLifecycleTag?: string;
  executionGrant?: {
    sources: Array<{ path: string; sha256: string }>;
    deadline: number;
    budget: { path: string; nodeId: string; ownerHash: string };
  };
  networkApproval?: { port: number; token: string; contextId?: string };
  networkGrants?: { path: string; profile: NetworkGrantProfile };
};
if (process.platform === "darwin" && !manifest.supervisor)
  throw new Error("macOS sandbox requires the native descendant supervisor");
const owner = process.ppid;
const kill = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
};
process.once("disconnect", kill);
const validGrant = () => {
  try {
    const grant = manifest.executionGrant;
    if (!grant) return true;
    if (
      Date.now() >= grant.deadline ||
      !grant.sources.every(
        ({ path, sha256 }) =>
          createHash("sha256").update(readFileSync(path)).digest("hex") === sha256,
      )
    )
      return false;
    const budget = JSON.parse(readFileSync(grant.budget.path, "utf8"));
    if (
      budget.cancelledOperations?.[grant.budget.ownerHash] ||
      budget.cancelled ||
      budget.deadline <= Date.now()
    )
      return false;
    let node = grant.budget.nodeId;
    const seen = new Set();
    while (node) {
      if (seen.has(node) || !budget.nodes?.[node]) return false;
      seen.add(node);
      const value = budget.nodes[node];
      if (value.cancelled || value.deadline <= Date.now()) return false;
      node = value.parent;
    }
    return true;
  } catch {
    return false;
  }
};
if (!validGrant()) throw new Error("Execution grant revoked or expired before launch");
const ownerTimer = setInterval(() => {
  if (process.ppid !== owner || process.ppid === 1 || !validGrant()) kill();
}, 250);
const deadline = setTimeout(kill, (manifest.timeoutSeconds + 1) * 1000);
const envArgs = Object.entries(manifest.env).map(([key, value]) => `${key}=${value}`);
const { startSandboxNetwork } = await import(
  new URL(import.meta.url.endsWith(".ts") ? "./network.ts" : "./network.js", import.meta.url).href
);
const configured = JSON.parse(readFileSync(manifest.settings, "utf8"));
const baseNetwork =
  manifest.networkPolicy ??
  (!configured.network.deniedDomains.includes("*")
    ? {
        mode: "allowlist" as const,
        allowedDomains: configured.network.allowedDomains,
        deniedDomains: configured.network.deniedDomains,
      }
    : { mode: "none" as const });
const { networkGrantSource } = (await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./network-grant-state.ts" : "./network-grant-state.js",
    import.meta.url,
  ).href
)) as typeof import("./network-grant-state.js");
const { requestNetworkApproval } = (await import(
  new URL(
    import.meta.url.endsWith(".ts")
      ? "./network-approval-client.ts"
      : "./network-approval-client.js",
    import.meta.url,
  ).href
)) as typeof import("./network-approval-client.js");
const approveNetwork =
  manifest.networkApproval && manifest.networkGrants
    ? (host: string, port: number, transport: "http" | "https", signal: AbortSignal) => {
        const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host);
        if ((transport === "http" || port !== 443) && !ip) return Promise.resolve(false);
        return requestNetworkApproval(
          manifest.networkApproval!,
          ip ? `${host}:${port}` : host,
          manifest.networkGrants!.profile,
          signal,
          manifest.networkApproval!.contextId,
        );
      }
    : undefined;
const network = await startSandboxNetwork(
  baseNetwork,
  manifest.networkGrants
    ? networkGrantSource(baseNetwork, manifest.networkGrants.path, manifest.networkGrants.profile)
    : undefined,
  approveNetwork,
);
configured.network.httpProxyPort = network.httpPort;
configured.network.socksProxyPort = network.socksPort;
writeFileSync(manifest.settings, JSON.stringify(configured), { mode: 0o600 });
// Keep only SRT's proxy endpoints when rebuilding the workload environment.
// Numeric proxy hosts avoid libc DNS/hosts lookups inside the confined kernel.
// Expansions are fixed shell code; all workload arguments remain positional.
const runtimeArgs = [
  manifest.cli,
  "--settings",
  manifest.settings,
  "--",
  "/bin/sh",
  "-c",
  'proxy_ip() { case "$1" in *://localhost:*) printf "%s://127.0.0.1:%s" "${1%%://*}" "${1#*://localhost:}" ;; *) printf "%s" "$1" ;; esac; }; exec /usr/bin/env -i PI_SCIENCE_SANDBOX_HTTP_PROXY="$(proxy_ip "$HTTP_PROXY")" HTTP_PROXY="$(proxy_ip "$HTTP_PROXY")" HTTPS_PROXY="$(proxy_ip "$HTTPS_PROXY")" ALL_PROXY="$(proxy_ip "$ALL_PROXY")" http_proxy="$(proxy_ip "$http_proxy")" https_proxy="$(proxy_ip "$https_proxy")" all_proxy="$(proxy_ip "$all_proxy")" NO_PROXY="$NO_PROXY" no_proxy="$no_proxy" "$@"',
  "sandbox-env",
  ...envArgs,
  ...manifest.argv,
  ...shellArgs,
];
let linuxManager: typeof import("@anthropic-ai/sandbox-runtime").SandboxManager | undefined;
let linuxLaunch: { argv: string[]; env: NodeJS.ProcessEnv } | undefined;
if (process.platform === "linux") {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  linuxManager = SandboxManager;
  await SandboxManager.initialize(configured);
  await SandboxManager.waitForNetworkInitialization();
  // SRT mounts its bridge sockets before applying filesystem masks. Preserve
  // exactly those sockets under the root deny, never their private parent.
  const sockets = [
    SandboxManager.getLinuxHttpSocketPath(),
    SandboxManager.getLinuxSocksSocketPath(),
  ].filter((path): path is string => !!path);
  SandboxManager.updateConfig({
    ...configured,
    filesystem: {
      ...configured.filesystem,
      allowRead: [
        ...configured.filesystem.allowRead,
        ...sockets.map((path) => ({ path, literal: true })),
      ],
    },
  });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  linuxLaunch = await SandboxManager.wrapWithSandboxArgv(runtimeArgs.slice(4).map(quote).join(" "));
}
if (!validGrant()) throw new Error("Execution grant revoked before process start");
const child = spawn(
  linuxLaunch?.argv[0] ?? manifest.supervisor ?? process.execPath,
  linuxLaunch
    ? linuxLaunch.argv.slice(1)
    : manifest.supervisor
      ? [
          String(manifest.timeoutSeconds + 1),
          manifest.lifecycleTag!,
          manifest.deniedLifecycleTag!,
          process.execPath,
          ...runtimeArgs,
        ]
      : runtimeArgs,
  {
    shell: false,
    stdio: ["inherit", "inherit", "inherit"],
    env: linuxLaunch?.env ?? process.env,
    ...(manifest.supervisor ? { detached: true } : {}),
  },
);
// Signal the real bridge, not the CLI (whose startup interrupt terminates srt).
const interrupt = (pid: number) => {
  try {
    if (process.platform === "darwin") {
      // NOTE_TRACK owns cleanup; ps is used only to target a cooperative
      // bridge interrupt without interrupting the proxy/CLI which owns it.
      const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 4 * 1024 * 1024,
      })
        .split("\n")
        .flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
          return match
            ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }]
            : [];
        });
      const descendants = new Set([pid]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const item of processes)
          if (descendants.has(item.parent) && !descendants.has(item.pid)) {
            descendants.add(item.pid);
            changed = true;
          }
      }
      for (const item of processes)
        if (
          descendants.has(item.pid) &&
          manifest.kernelBridge &&
          item.command.includes(` -I -B ${manifest.kernelBridge}`)
        )
          process.kill(item.pid, "SIGINT");
      return;
    }
    // /proc/.../children is absent on some Linux runtimes; stat's PPid is portable.
    const children = readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .filter((candidate) => {
        try {
          const stat = readFileSync(`/proc/${candidate}/stat`, "utf8");
          return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid;
        } catch {
          return false;
        }
      });
    for (const descendant of children) {
      const argv = readFileSync(`/proc/${descendant}/cmdline`, "utf8").split("\0");
      if (
        manifest.kernelBridge &&
        argv[1] === "-I" &&
        argv[2] === "-B" &&
        argv[3] === manifest.kernelBridge
      )
        process.kill(descendant, "SIGINT");
      else interrupt(descendant);
    }
  } catch {
    /* exited while walking */
  }
};
process.on("message", (message) => {
  if (message === "interrupt" && child.pid) interrupt(child.pid);
});
child.once("error", kill);
child.once("close", (code) => {
  clearInterval(ownerTimer);
  clearTimeout(deadline);
  void Promise.all([network.close(), linuxManager?.reset()]).finally(() => process.exit(code ?? 1));
});
