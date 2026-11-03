import Fastify from "fastify";
import { registerMcpRoutes } from "../../http/routes/mcp-routes.js";
import { McpConnectorService } from "../../mcp/connector-service.js";
import { McpRuntimeProjection } from "../../mcp/runtime-projection.js";
import { InMemorySqliteStateStore } from "../../storage/sqlite/state-store.js";
import { McpRepository } from "../../storage/sqlite/repositories/mcp-repository.js";
import { WorkspaceRepository } from "../../storage/sqlite/repositories/workspace-repository.js";
import { SettingsStore } from "../../storage/settings-store.js";
import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { cp, link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeNetworkGrant, revokeNetworkGrant, networkGrantsPath } from "./network-grants.js";
import type { SandboxProfile } from "./profiles.js";
import { workspacePolicy } from "./policy.js";
import { killSandboxGroup, launcherPath, prepareSandbox } from "./process.js";
import { NodeKernelManager } from "../kernel/node-kernel-manager.js";
import { runEnvironmentProcess } from "./environment-process.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { localMcpTransport } from "../../mcp/sandbox-transport.js";
import { JobCoordinator } from "../jobs/job-coordinator.js";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { BACKGROUND_CONTEXT, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { writeSandboxFile } from "./file-write.js";
import { AgentMcpTools } from "../agent/worker/mcp-tools.js";
import { InteractionBridge } from "../agent/worker/interaction-bridge.js";
import { builtinMcpConnectors } from "../../mcp/builtin-connectors.js";

const roots: string[] = [];
const managers: NodeKernelManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll())); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(await realpath("/tmp"), "ps-accept-")); roots.push(root); return root; }
async function execute(cwd: string, argv: string[], dependencies: string[] = [], timeoutSeconds = 10, profile: SandboxProfile = "analysis") {
  const prepared = await prepareSandbox(await workspacePolicy(cwd, undefined, profile), argv, dependencies, timeoutSeconds);
  let stdout = "", stderr = "";
  const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout!.on("data", (chunk) => stdout += chunk); child.stderr!.on("data", (chunk) => stderr += chunk);
  try { const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); return { code, stdout, stderr }; }
  finally { killSandboxGroup(child.pid); await prepared.cleanup(); }
}

describe.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["darwin", "linux"].includes(process.platform))("real platform sandbox acceptance", () => {
  it.skipIf(process.platform !== "linux")("keeps seccomp active and denies namespace capabilities and remounts in the workload", async () => {
    const cwd = await fixture();
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const script = `set -eu
      seccomp=0; no_new_privs=0; caps=0
      while read -r key value rest; do
        case "$key" in
          Seccomp:) seccomp="$value" ;;
          NoNewPrivs:) no_new_privs="$value" ;;
          CapEff:) caps="$value" ;;
        esac
      done < /proc/self/status
      test "$seccomp" = 2
      test "$no_new_privs" = 1
      test "$((16#$caps & 0x200000))" = 0
      if mount -o remount,rw / 2>/dev/null; then exit 77; fi
      echo seccomp-isolated`;
    const result = await execute(cwd, ["/bin/bash", "-c", script]);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "seccomp-isolated\n" });
  }, 30_000);
  it("runs real Bash, denies credentials/outside writes/network and captures ordinary output", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "must-not-be-inherited");
    await writeFile(join(cwd, ".netrc"), "SECRET");
    const result = await execute(cwd, ["/bin/bash", "-c", "set -e; test -z \"$OPENAI_API_KEY\"; test ! -s /etc/passwd; test ! -s .netrc; printf success > result.txt; if curl -sS --max-time 2 https://example.com >/dev/null 2>&1; then exit 77; fi; echo isolated"]);
    // Linux masks denied files with empty files; macOS returns permission errors.
    expect(await readFile(join(cwd, ".netrc"), "utf8")).toBe("SECRET");
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "isolated\n" }); expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("success");
  }, 30_000);
  it.skipIf(!process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT)("executes enabled skill helpers read-only while keeping .pi configuration and disabled skills hidden", async () => {
    const cwd = await fixture(), externalRoot = await fixture();
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    vi.stubEnv("PI_SCIENCE_HOME", await fixture());
    const skill = join(cwd, ".pi/skills/stats-integrity");
    const external = join(externalRoot, "custom-skill");
    await mkdir(skill, { recursive: true }); await mkdir(external);
    await cp(fileURLToPath(new URL("../../../../../skills/stats-integrity", import.meta.url)), skill, { recursive: true });
    await writeFile(join(skill, "helper.sh"), "printf 'shell-helper-ok\n'\n");
    await writeFile(join(external, "SKILL.md"), "external helper");
    await writeFile(join(external, "helper.sh"), "printf 'external-helper-ok\n'\n");
    await writeFile(join(externalRoot, "sibling.txt"), "SECRET");
    await writeFile(join(cwd, ".pi/settings.json"), "SECRET");
    await mkdir(join(cwd, ".pi/prompts")); await writeFile(join(cwd, ".pi/prompts/private.md"), "SECRET");
    await mkdir(join(cwd, ".pi/skills/disabled")); await writeFile(join(cwd, ".pi/skills/disabled/helper.sh"), "SECRET");
    await writeFile(join(skill, "credentials.json"), "SECRET");
    await symlink(join(cwd, ".pi/settings.json"), join(skill, "linked.txt"));
    await link(join(cwd, ".pi/settings.json"), join(skill, "hardlinked.txt"));
    await writeFile(join(cwd, "study.md"), "Observational association without a causal claim.");
    let enabled = true;
    const tool = sandboxBashTool({ cwd, sessionId: "skill-helpers" }, {}, async () => enabled ? [skill, external] : []);
    const run = (id: string, command: string) => tool.execute(id, { command, timeout: 20 }, () => {}, { env: new NodeExecutionEnv({ cwd }) },
      { operationId: "skills", invocationId: id, turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} }, BACKGROUND_CONTEXT);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const helper = join(skill, "stats_integrity_check.py");
    const blocked = [join(cwd, ".pi/settings.json"), join(cwd, ".pi/prompts/private.md"), join(cwd, ".pi/skills/disabled/helper.sh"), join(skill, "credentials.json"), join(skill, "linked.txt"), join(skill, "hardlinked.txt"), join(externalRoot, "sibling.txt")];
    const result = await run("enabled", ["set -e", `${quote(process.env.PI_SCIENCE_SANDBOX_PYTHON!)} -B ${quote(helper)} study.md > review.json`,
      `/bin/bash ${quote(join(skill, "helper.sh"))}`, `/bin/bash ${quote(join(external, "helper.sh"))}`,
      ...blocked.map((path) => `test ! -s ${quote(path)}`),
      `if printf changed > ${quote(helper)} 2>/dev/null; then exit 71; fi`,
      `if printf changed > ${quote(join(external, "helper.sh"))} 2>/dev/null; then exit 72; fi`, "echo skills-readonly"].join("; "));
    expect(JSON.stringify(result.content)).toContain("skills-readonly");
    expect(await readFile(join(cwd, "review.json"), "utf8")).toContain("Stats integrity gate");
    expect(await readFile(join(external, "helper.sh"), "utf8")).toContain("external-helper-ok");
    // Changes after the first invocation must be protected on the next one,
    // including a helper whose link count changed via an external directory.
    const lateSecret = join(skill, "credentials-late.json"), lateAlias = join(skill, "late-alias.txt");
    await writeFile(lateSecret, "SECRET");
    await symlink(join(externalRoot, "sibling.txt"), lateAlias);
    await link(join(skill, "helper.sh"), join(externalRoot, "late-helper-link.sh"));
    const refreshed = await run("refreshed", [...[lateSecret, lateAlias, join(skill, "helper.sh")].map((path) => `test ! -s ${quote(path)}`), "echo skills-refreshed"].join(" && "));
    expect(JSON.stringify(refreshed.content)).toContain("skills-refreshed");
    enabled = false;
    expect(JSON.stringify((await run("disabled", `test ! -s ${quote(helper)} && test ! -s ${quote(join(external, "helper.sh"))} && echo skills-disabled`)).content)).toContain("skills-disabled");
  }, 60_000);
  it("removes descendants which detach and outlive the original command", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const descendant = "setTimeout(()=>require('node:fs').writeFileSync('leaked.txt','escaped'),1500);setInterval(()=>{},1000)";
    const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref();console.log('spawned')`;
    const result = await execute(cwd, [process.execPath, "-e", code], [process.execPath]);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "spawned\n" });
    await new Promise((resolve) => setTimeout(resolve, 1700)); await expect(readFile(join(cwd, "leaked.txt"))).rejects.toThrow();
  }, 30_000);
  it("enforces the independent execution deadline", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const started = Date.now();
    const result = await execute(cwd, ["/bin/bash", "-c", "echo ready; sleep 30; touch leaked.txt"], [], 1);
    expect(result.stdout).toContain("ready"); expect(result.code).not.toBe(0); expect(Date.now() - started).toBeLessThan(8000);
    await expect(readFile(join(cwd, "leaked.txt"))).rejects.toThrow();
  }, 15_000);
  it("permits allowlisted HTTPS and refuses an unlisted destination", async () => {
    const cwd = await fixture(), control = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const config = join(control, "profiles.json");
    await writeFile(config, JSON.stringify({ schemaVersion: 1, profiles: { analysis: { allowedDomains: ["example.com"] } } }), { mode: 0o600 });
    vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", config);
    const result = await execute(cwd, ["/bin/bash", "-c", "set -e; curl -sS --fail --max-time 15 https://example.com -o allowed.html; if curl -sS --fail --max-time 2 https://example.org >/dev/null 2>&1; then exit 77; fi; echo filtered"], [], 25);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "filtered\n" }); expect(await readFile(join(cwd, "allowed.html"), "utf8")).toContain("Example Domain");
  }, 40_000);
  it.skipIf(!process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT)("runs persistent Python cells and isolates the installed environment", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const prefix = process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT!;
    const manager = new NodeKernelManager(); managers.push(manager);
    const options = { cwd, language: "python" as const, environment: { ready: true, workspace: cwd, prefix, python: join(prefix, "bin/python3"), pip: join(prefix, "bin/pip"), npm: { local_prefix: cwd, global_prefix: cwd, cache: cwd } }, timeoutMs: 10_000 };
    expect(await manager.execute({ ...options, code: "state=40\nprint('ready')" })).toMatchObject({ ok: true, stdout: "ready\n" });
    expect(await manager.execute({ ...options, code: "print(state+2)" })).toMatchObject({ ok: true, stdout: "42\n" });
    expect(await manager.execute({ ...options, code: `import os\ntry:\n open(${JSON.stringify(join(prefix, "forbidden-by-sandbox"))},'w'); raise AssertionError('environment writable')\nexcept OSError: pass\nprint('readonly')` })).toMatchObject({ ok: true, stdout: "readonly\n" });
  }, 30_000);
  it.skipIf(!process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT)("downgrades only after retiring the sandbox group when its launcher exits normally", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    vi.stubEnv("PI_SCIENCE_HOME", await fixture());
    const { saveSessionApproval } = await import("./session-approval.js");
    const { AgentCoreSessionService } = await import("../agent/agent-core-session-service.js");
    const { workspaceIdentity } = await import("../agent/workspace-session-identity.js");
    await saveSessionApproval(cwd, "retiring-owner", "full", 0);
    const prefix = process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT!;
    let launcher: ReturnType<typeof spawn> | undefined;
    // Test-only hook lets the real launcher exit with code 0 while its workload
    // is still running, without terminating that workload via a group signal.
    const exitHook = "data:text/javascript," + encodeURIComponent("process.on('SIGUSR2',()=>process.exit(0))");
    const manager = new NodeKernelManager({ spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) =>
      (launcher = spawn(command, ["--import", exitHook, ...args], options))) as typeof spawn });
    managers.push(manager);
    const policy = await workspacePolicy(cwd, undefined, "analysis", "retiring-owner");
    const result = await manager.execute({ cwd, language: "python", environment: { ready: true, workspace: cwd, prefix,
      python: join(prefix, "bin/python3"), pip: join(prefix, "bin/pip"), npm: { local_prefix: cwd, global_prefix: cwd, cache: cwd } },
      sandboxPolicy: policy, timeoutMs: 10_000,
      code: "import subprocess\nbackground=subprocess.Popen(['/bin/sh','-c','sleep 2; echo leaked > leaked.txt'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint('spawned')" });
    expect(result).toMatchObject({ ok: true, stdout: "spawned\n" });
    const exited = new Promise<void>((resolve) => launcher!.once("exit", () => resolve()));
    launcher!.kill("SIGUSR2");
    await exited;
    expect(launcher!.exitCode).toBe(0);
    const service = new AgentCoreSessionService({ expectExit: vi.fn(), publish: vi.fn(async () => undefined) } as never, {} as never, {
      hasApprovalResources: (workspace, owner) => manager.hasOwner(workspace, owner),
      revokeApprovalResources: (workspace, owner) => manager.revokeOwner(workspace, owner),
    });
    const runtime = { cwd, sessionId: "retiring-owner", isClosed: false, sendCommand: vi.fn(async () => ({ success: true, data: { busy: false, queues: [], operation: null } })) };
    (service as unknown as { live: Map<string, unknown> }).live.set(`${workspaceIdentity(cwd)}\0retiring-owner`, { key: "owner-worker", runtime, busy: false });
    expect(await service.setApprovalMode(cwd, "retiring-owner", "ask", 1)).toMatchObject({ success: true, data: { mode: "ask", revision: 2 } });
    expect(manager.hasOwner(cwd, "retiring-owner")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await expect(readFile(join(cwd, "leaked.txt"))).rejects.toThrow();
  }, 30_000);
  it.skipIf(!process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT)("grants and revokes network access in a running Python kernel without losing state", async () => {
    const cwd = await fixture(), home = await fixture();
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_HOME", home); vi.stubEnv("PI_SCIENCE_SANDBOX_PROFILES", "");
    const prefix = process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT!;
    const manager = new NodeKernelManager(); managers.push(manager);
    const options = { cwd, language: "python" as const, environment: { ready: true, workspace: cwd, prefix, python: join(prefix, "bin/python3"), pip: join(prefix, "bin/pip"), npm: { local_prefix: cwd, global_prefix: cwd, cache: cwd } }, timeoutMs: 20_000 };
    // A verified TLS handshake proves the HTTPS tunnel works without depending
    // on the public site's HTTP status (example.com can temporarily return 503).
    const probe = [
      "import contextlib, http.client, urllib.request, urllib.parse",
      "def probe_https():",
      " proxy=urllib.parse.urlsplit(urllib.request.getproxies()['https'])",
      " with contextlib.closing(http.client.HTTPSConnection(proxy.hostname,proxy.port,timeout=15)) as connection:",
      "  connection.set_tunnel('example.com',443)",
      "  connection.connect()",
    ].join("\n");
    const blocked = "try:\n probe_https()\nexcept Exception:\n print('blocked')\nelse:\n raise AssertionError('network unexpectedly open')";
    expect(await manager.execute({ ...options, code: "state=42\nimport os\noriginal_pid=os.getpid()\n" + probe + "\n" + blocked })).toMatchObject({ ok: true, stdout: "blocked\n" });
    await changeNetworkGrant({ profile: "analysis", domain: "example.com", decision: "allow" }, "settings");
    const granted = await manager.execute({ ...options, code: "assert state==42 and os.getpid()==original_pid\nprobe_https()\nprint('connected')" });
    expect(granted, JSON.stringify(granted)).toMatchObject({ ok: true, stdout: "connected\n" });
    for (const profile of ["mcp", "control"] as const) {
      const confined = await execute(cwd, ["/bin/bash", "-c", "if curl -sS --fail --max-time 2 https://example.com >/dev/null 2>&1; then exit 77; fi; echo role-isolated"], [], 5, profile);
      expect(confined, confined.stderr).toMatchObject({ code: 0, stdout: "role-isolated\n" });
    }
    await revokeNetworkGrant("analysis", "example.com");
    expect(await manager.execute({ ...options, code: "assert state==42 and os.getpid()==original_pid\n" + blocked })).toMatchObject({ ok: true, stdout: "blocked\n" });
    expect(await manager.execute({ ...options, code: `try:\n open(${JSON.stringify(networkGrantsPath())}).read()\nexcept OSError:\n print('permissions-protected')\nelse:\n raise AssertionError('permission state exposed')` })).toMatchObject({ ok: true, stdout: "permissions-protected\n" });
  }, 60_000);
  it("confines installer writes to its new prefix and cache", async () => {
    const root = await fixture(), prefix = join(root, "env"), cache = join(root, "pkgs"), workspace = join(root, "workspace");
    await mkdir(workspace); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    await runEnvironmentProcess("/bin/bash", ["-c", `set -e; test -s "$CONDA_SSL_VERIFY"; test "$CONDA_SSL_VERIFY" = "$MAMBA_SSL_VERIFY"; test -z "$(ls -A '${prefix}')"; touch '${prefix}/installed'; touch '${cache}/cached'; if touch '${workspace}/escaped' 2>/dev/null; then exit 77; fi`], prefix, cache, 10_000);
    expect(await readFile(join(prefix, "installed"), "utf8")).toBe(""); await expect(readFile(join(workspace, "escaped"))).rejects.toThrow();
  }, 30_000);
  it("confines a real MCP server while passing only its own explicitly bound credential", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "host-model-key");
    const script = join(cwd, "server.mjs");
    await writeFile(script, `import {McpServer} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};\nimport {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};\nimport fs from 'node:fs';\nconst server=new McpServer({name:'isolated',version:'1'});server.registerTool('inspect',{},async()=>({content:[{type:'text',text:JSON.stringify({token:process.env.TOKEN,hostKey:!!process.env.OPENAI_API_KEY,passwd:fs.existsSync('/etc/passwd')})}]}));await server.connect(new StdioServerTransport());`);
    const transport = await localMcpTransport(cwd, process.execPath, [script], cwd, { TOKEN: "connector-only" });
    const client = new Client({ name: "acceptance", version: "1" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "inspect", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ token: "connector-only", hostKey: false, passwd: false }) }]);
    } finally { await client.close(); }
  }, 30_000);
  it.each(["paper-search", "literature-graph"])("starts builtin %s inside the narrow MCP sandbox within discovery budget", async (name) => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const builtin = builtinMcpConnectors().find((connector) => connector.definition.name === name)!;
    const definition = builtin.definition;
    const client = new Client({ name: "builtin-acceptance", version: "1" });
    try {
      const started = Date.now();
      await client.connect(await localMcpTransport(cwd, definition.command!, definition.args, cwd, {}, name), { timeout: 10_000 });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(builtin.tools.map((tool) => tool.name)));
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { await client.close(); }
  }, 30_000);
  it("discovers builtin connectors concurrently within the worker budget", async () => {
    const cwd = await fixture(), home = await fixture();
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_HOME", home);
    const builtins = builtinMcpConnectors().filter((connector) => ["paper-search", "literature-graph"].includes(connector.definition.name));
    await mkdir(join(cwd, ".pi-science"));
    const store = new InMemorySqliteStateStore();
    await store.start();
    const repository = new McpRepository(store);
    const service = new McpConnectorService(repository, new WorkspaceRepository(store), new SettingsStore(), undefined, new McpRuntimeProjection(repository));
    const authority = Fastify();
    registerMcpRoutes(authority, service, false);
    for (const builtin of builtins) await repository.upsertBuiltin(builtin.connector_id, builtin.definition, true);
    await service.materializeWorkspace(cwd);
    vi.stubEnv("PI_SCIENCE_BACKEND_URL", await authority.listen({ host: "127.0.0.1", port: 0 }));
    const started = Date.now();
    const mcp = await AgentMcpTools.open(cwd, new InteractionBridge(() => {}), {});
    try {
      expect(mcp.diagnostics).toEqual([]);
      expect(mcp.tools).toHaveLength(builtins.reduce((count, builtin) => count + builtin.tools.length, 0));
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { await mcp.close(); await authority.close(); await store.close(); }
  }, 20_000);
  it("denies builtin workspace reads/writes while allowing private scratch writes", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    await writeFile(join(cwd, "private.txt"), "workspace-private");
    const code = `import fs from 'node:fs';
      import {McpServer} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
      import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
      const workspace = ${JSON.stringify(cwd)};
      const server = new McpServer({name:'builtin-boundary',version:'1'});
      server.registerTool('inspect',{},async()=>{
        let read=false,write=false,codeWrite=false;
        try { read=fs.readFileSync(workspace+'/private.txt','utf8')==='workspace-private'; } catch {}
        try { fs.writeFileSync(workspace+'/escaped','bad'); write=true; } catch {}
        try { fs.writeFileSync('escaped','bad'); codeWrite=true; } catch {}
        fs.writeFileSync(process.env.HOME+'/scratch-test','ok');
        return {content:[{type:'text',text:JSON.stringify({read,write,codeWrite,scratch:true})}]};
      }); await server.connect(new StdioServerTransport());`;
    const client = new Client({ name: "builtin-boundary", version: "1" });
    try {
      await client.connect(await localMcpTransport(cwd, process.execPath, ["--input-type=module", "-e", code], cwd, {}, "paper-search"));
      expect((await client.callTool({ name: "inspect" })).content).toEqual([{ type: "text", text: JSON.stringify({ read: false, write: false, codeWrite: false, scratch: true }) }]);
    } finally { await client.close(); }
    expect(await readFile(join(cwd, "private.txt"), "utf8")).toBe("workspace-private");
  }, 20_000);
  it.skipIf(process.platform !== "linux")("calls arXiv and OpenAlex through HTTPS without DNS in the real MCP sandbox", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const key = join(cwd, "test-key.pem"), cert = join(cwd, "test-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
      "-days", "1", "-subj", "/CN=sandbox-test", "-addext", "subjectAltName=DNS:export.arxiv.org,DNS:api.openalex.org"], { stdio: "ignore" });
    for (const [connectorId, tool, args] of [
      ["mcp_builtin_paper_search", "search_arxiv", { query: "sandbox DNS", limit: 1 }],
      ["mcp_builtin_literature_graph", "search_openalex_works", { query: "sandbox DNS", per_page: 1 }],
    ] as const) {
      const definition = builtinMcpConnectors().find((connector) => connector.connector_id === connectorId)!.definition;
      const wrapper = join(cwd, `${tool}.mjs`);
      const entryIndex = definition.args!.findIndex((arg) => /\.(?:ts|js)$/.test(arg));
      const entry = definition.args![entryIndex]!;
      // Controlled HTTPS upstream only: real TLS verification, real SDK tool
      // handlers and transport, no external API or DNS dependency. The workload
      // still uses the product's normal Linux OS confinement.
      await writeFile(wrapper, `import fs from 'node:fs';
process.on('uncaughtException', error=>{fs.writeFileSync(${JSON.stringify(join(cwd, 'fixture-error.txt'))},String(error.stack));process.exit(1)});
import http from 'node:http';
import tls from 'node:tls';
import dns from 'node:dns/promises';
if(fs.existsSync('/etc/resolv.conf')) throw Error('test requires isolated DNS');
try { await dns.lookup('no-dns.invalid'); throw Error('DNS unexpectedly available'); }
catch(error) { if(error.code !== 'ENOTFOUND' && error.code !== 'EAI_AGAIN') throw error; }
tls.setDefaultCACertificates([...tls.getCACertificates(),${JSON.stringify(await readFile(cert, "utf8"))}]);
const context=tls.createSecureContext({key:${JSON.stringify(await readFile(key, "utf8"))},cert:${JSON.stringify(await readFile(cert, "utf8"))}});
const proxy=http.createServer();
proxy.on('connect',(req,socket)=>{
 socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
 const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:context});
 secure.once('data',()=>{
  const arxiv=req.url==='export.arxiv.org:443';
  if(!arxiv && req.url!=='api.openalex.org:443') throw Error('Unexpected upstream');
  const body=arxiv?'<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>0</opensearch:totalResults></feed>':JSON.stringify({meta:{count:0},results:[]});
  secure.end('HTTP/1.1 200 OK\\r\\nContent-Type: '+(arxiv?'application/atom+xml':'application/json')+'\\r\\nContent-Length: '+Buffer.byteLength(body)+'\\r\\nConnection: close\\r\\n\\r\\n'+body);
 });
});
await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
process.env.PI_SCIENCE_SANDBOX_HTTP_PROXY='http://127.0.0.1:'+proxy.address().port;
process.env.NO_PROXY='*'; process.env.no_proxy='*';
process.argv=[process.argv[0],...${JSON.stringify(definition.args!.slice(entryIndex))}];
${entry.endsWith(".ts") ? `await import(${JSON.stringify(import.meta.resolve("tsx"))});` : ""}
await import(${JSON.stringify(new URL(entry, "file:///").href)});
`);
      const client = new Client({ name: "dns-acceptance", version: "1" });
      try {
        await client.connect(await localMcpTransport(cwd, definition.command!, [wrapper], cwd, {}));
        const result = await client.callTool({ name: tool, arguments: args });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ records: [], total: 0 });
      } catch (error) { throw new Error(await readFile(join(cwd, "fixture-error.txt"), "utf8").catch(() => String(error))); }
      finally { await client.close(); }
    }
  }, 40_000);

  it("routes unresolved MCP hostnames to the real policy proxy and rejects connector proxy overrides", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const script = join(cwd, "proxy-check.mjs");
    const fetchModule = new URL("../../mcp/runtime-fetch.ts", import.meta.url).href;
    await writeFile(script, `await import(${JSON.stringify(import.meta.resolve("tsx"))});
const {createMcpFetch}=await import(${JSON.stringify(fetchModule)});
if(!process.env.PI_SCIENCE_SANDBOX_HTTP_PROXY?.startsWith('http://127.0.0.1:')) throw Error('missing trusted proxy');
try { await createMcpFetch({connectorId:'test',endpoint:'https://no-dns.invalid',allowPrivate:false})('https://no-dns.invalid'); throw Error('unexpected access'); }
catch(error) { let message=''; for(let cause=error;cause;cause=cause.cause) message+=String(cause.message); if(!message.includes('Proxy response (403)')) throw error; console.log('policy-proxy-denied-without-DNS'); }
`);
    const policy = await workspacePolicy(cwd, undefined, "mcp");
    const prepared = await prepareSandbox(policy, [process.execPath, script], [process.execPath, new URL("../../../", import.meta.url).pathname, new URL("../../../../../node_modules", import.meta.url).pathname, new URL("../../../../../package.json", import.meta.url).pathname], 10,
      undefined, undefined, { PI_SCIENCE_SANDBOX_HTTP_PROXY: "http://attacker.invalid:1", NO_PROXY: "*" });
    const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (data) => stdout += data); child.stderr!.on("data", (data) => stderr += data);
    try {
      const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
      expect({ code, stdout }, stderr).toEqual({ code: 0, stdout: "policy-proxy-denied-without-DNS\n" });
    } finally { killSandboxGroup(child.pid); await prepared.cleanup(); }
  }, 30_000);
  it("preserves the actual Bash tool output and artifact path through its OS adapter", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const result = await sandboxBashTool({ cwd, sessionId: "acceptance" }).execute("bash", { command: "test ! -r /etc/passwd && printf result > result.txt && echo bash-tool-isolated", timeout: 10 }, () => {}, { env: new NodeExecutionEnv({ cwd }) },
      { operationId: "operation", invocationId: "bash", turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} }, BACKGROUND_CONTEXT);
    expect(JSON.stringify(result.content)).toContain("bash-tool-isolated"); expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("result");
  }, 30_000);
  it.skipIf(process.platform !== "darwin")("performs native file-tool commits inside a confined helper", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    await writeSandboxFile(cwd, join(cwd, "nested", "file.txt"), "saved");
    expect(await readFile(join(cwd, "nested", "file.txt"), "utf8")).toBe("saved");
    await expect(writeSandboxFile(cwd, join(cwd, ".pi-science", "blocked"), "must-not-write")).rejects.toThrow();
    await expect(readFile(join(cwd, ".pi-science", "blocked"))).rejects.toThrow();
  }, 30_000);
  it("keeps background jobs inside the same sandbox despite request-shaped mode overrides", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const jobs = new JobCoordinator({ environment: async () => ({ PATH: "/usr/bin:/bin" }) });
    try {
      const record = await jobs.submit(cwd, { command: ["/bin/bash", "-c", "test ! -r /etc/passwd && echo job-isolated"], env: { PI_SCIENCE_EXECUTION_MODE: "trusted-host" } });
      let result = record;
      for (let i = 0; i < 200; i++) { result = (await jobs.get(cwd, record.job_id))!; if (["succeeded", "failed", "cancelled", "timed_out"].includes(result.status)) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      expect(result).toMatchObject({ status: "succeeded", stdout: "job-isolated\n", environment: { execution_mode: "required", sandbox_policy_id: expect.any(String) } });
    } finally { await jobs.shutdown(); }
  }, 30_000);
});
