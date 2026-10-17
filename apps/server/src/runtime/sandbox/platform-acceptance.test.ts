import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { builtinMcpConnectors } from "../../mcp/builtin-connectors.js";

const roots: string[] = [];
const managers: NodeKernelManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll())); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(await realpath("/tmp"), "ps-accept-")); roots.push(root); return root; }
async function execute(cwd: string, argv: string[], dependencies: string[] = [], timeoutSeconds = 10) {
  const prepared = await prepareSandbox(await workspacePolicy(cwd), argv, dependencies, timeoutSeconds);
  let stdout = "", stderr = "";
  const child = spawn(process.execPath, [launcherPath, prepared.manifest], { cwd, env: prepared.env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout!.on("data", (chunk) => stdout += chunk); child.stderr!.on("data", (chunk) => stderr += chunk);
  try { const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); return { code, stdout, stderr }; }
  finally { killSandboxGroup(child.pid); await prepared.cleanup(); }
}

describe.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || !["darwin", "linux"].includes(process.platform))("real platform sandbox acceptance", () => {
  it("runs real Bash, denies credentials/outside writes/network and captures ordinary output", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "must-not-be-inherited");
    await writeFile(join(cwd, ".netrc"), "SECRET");
    const result = await execute(cwd, ["/bin/bash", "-c", "set -e; test -z \"$OPENAI_API_KEY\"; test ! -r /etc/passwd; test ! -r .netrc; printf success > result.txt; if curl -sS --max-time 2 https://example.com >/dev/null 2>&1; then exit 77; fi; echo isolated"]);
    expect(result, result.stderr).toMatchObject({ code: 0, stdout: "isolated\n" }); expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("success");
  }, 30_000);
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
  it("confines installer writes to its new prefix and cache", async () => {
    const root = await fixture(), prefix = join(root, "env"), cache = join(root, "pkgs"), workspace = join(root, "workspace");
    await mkdir(workspace); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    await runEnvironmentProcess("/bin/bash", ["-c", `set -e; touch installed; touch '${cache}/cached'; if touch '${workspace}/escaped' 2>/dev/null; then exit 77; fi`], prefix, cache, 10_000);
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
  it("starts the product's built-in Paper Search server inside the MCP sandbox", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const definition = builtinMcpConnectors()[0]!.definition;
    const client = new Client({ name: "builtin-acceptance", version: "1" });
    try {
      await client.connect(await localMcpTransport(cwd, definition.command!, definition.args, cwd, {}));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("search_pubmed");
    } finally { await client.close(); }
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
