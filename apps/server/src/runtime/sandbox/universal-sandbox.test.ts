import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, NodeExecutionEnv, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core/node";
import { sandboxBashTool } from "../agent/worker/sandbox-bash.js";
import { NodeKernelManager } from "../kernel/node-kernel-manager.js";
import type { WorkspaceEnvironmentStatus } from "../workspace/workspace-environment.js";
import { identifyPolicy, workspacePolicy } from "./policy.js";
import { executionRepository } from "../executions/execution-repository.js";
import Fastify from "fastify";
import { registerKernelExecutionRoutes } from "../../http/routes/kernel-execution-routes.js";
import type { ServerConfig } from "../../config/config.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { candidateKernelGrant, SANDBOX_GRANT_HEADER } from "./kernel-authorization.js";
import { executionBudgetTools } from "../agent/worker/execution-budget.js";
import { registerNotebookRoutes } from "../../http/routes/notebook-routes.js";
import type { NotebookService } from "../notebooks/notebook-service.js";
import { notebookHarnessTools } from "../agent/worker/notebook-tools.js";
import { processSettings } from "./settings.js";
import { sandboxArtifactCapture } from "./artifacts.js";
import { publishWorkspaceArtifactsDetailed } from "../artifacts/workspace-artifact-publisher.js";

const roots: string[] = [];
const managers: NodeKernelManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll())); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-universal-"))); roots.push(cwd);
  await mkdir(join(cwd, ".pi-science")); await writeFile(join(cwd, ".pi-science/secret"), "SECRET");
  await mkdir(join(cwd, "research/evaluator"), { recursive: true }); await writeFile(join(cwd, "research/evaluator/secret"), "SECRET");
  await writeFile(join(cwd, "data.txt"), "data");
  await writeFile(join(cwd, "token.json"), "SECRET");
  return cwd;
}
const invocation = (id: string): AgentHarnessToolInvocation => ({ operationId: "op", invocationId: id, turnId: "turn", getMemo: async () => undefined, setMemo: async () => {} });
async function bash(cwd: string, command: string, id = "bash", abortSignal?: AbortSignal, timeout = 10) {
  return sandboxBashTool({ cwd, sessionId: "session" }).execute(id, { command, timeout }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation(id), { ...BACKGROUND_CONTEXT, abortSignal });
}
function environment(cwd: string): WorkspaceEnvironmentStatus {
  const prefix = process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT ?? "/unavailable/test-env";
  return { ready: true, workspace: cwd, prefix, python: process.env.PI_SCIENCE_SANDBOX_PYTHON!, pip: join(prefix, "bin/pip"), manager: "micromamba", environment_id: "test", revision_id: "test-rev", npm: { local_prefix: cwd, global_prefix: cwd, cache: cwd } };
}
it("uses required mode by default and never accepts a tool parameter selecting host mode", async () => {
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "invalid");
  await expect(bash(await fixture(), "touch escaped", "blocked")).rejects.toThrow("operator execution mode");
});
it("refuses unvalidated R before starting any process", async () => {
  vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
  const cwd = await fixture(); const manager = new NodeKernelManager(); managers.push(manager);
  await expect(manager.execute({ cwd, language: "r", code: "1", environment: environment(cwd), timeoutMs: 1000 })).rejects.toThrow("R kernels");
  expect(manager.status().active_count).toBe(0);
});
it("fails closed when required runtime dependencies are missing", async () => {
  const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("PI_SCIENCE_SANDBOX_RIPGREP", "/missing/trusted/rg");
  await expect(bash(cwd, "touch escaped", "missing-runtime")).rejects.toThrow();
  await expect(readFile(join(cwd, "escaped"))).rejects.toThrow();
  expect((await executionRepository.list(cwd))[0]?.status).toBe("failed");
});
it.skipIf(process.platform !== "linux")("rejects aliased broad dependencies and writable trusted launchers", async () => {
  const cwd = await fixture(); const policy = await workspacePolicy(cwd);
  const aliasRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-runtime-alias-"))); roots.push(aliasRoot);
  await symlink("/", join(aliasRoot, "alias"));
  await expect(processSettings(policy, [join(aliasRoot, "alias")])).rejects.toThrow("narrow absolute");
  const server = fileURLToPath(new URL("../../../", import.meta.url));
  await expect(processSettings(identifyPolicy({ ...policy, writePaths: [server] }), [])).rejects.toThrow("trusted server installation");
});
it.skipIf(process.platform !== "linux")("captures only authorized regular output inodes and refuses evaluator links", async () => {
  const cwd = await fixture(); const work = join(cwd, "work"); await mkdir(work);
  const policy = identifyPolicy({ mode: "required", scope: "candidate", cwd: work, readPaths: [work], writePaths: [work], denyPaths: [], network: { mode: "none" } });
  await writeFile(join(work, "ok.json"), "42");
  await writeFile(join(cwd, "research/evaluator/secret.json"), "SECRET");
  await symlink(join(cwd, "research/evaluator/secret.json"), join(work, "linked.json"));
  await symlink(join(cwd, "research/evaluator"), join(work, "swapped"));
  const captured = await publishWorkspaceArtifactsDetailed(cwd, ["work/ok.json", "work/linked.json", "work/swapped/secret.json"], { tool: "test", captureFile: sandboxArtifactCapture(cwd, policy) });
  expect(captured.artifacts.map((artifact) => artifact.path)).toEqual(["work/ok.json"]);
  expect(captured.failures).toHaveLength(2);
  await writeFile(join(work, "huge.txt"), Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(sandboxArtifactCapture(cwd, policy)(join(work, "huge.txt"))).rejects.toThrow("bounded single-link");
});
describe.skipIf(process.env.PI_SCIENCE_SANDBOX_TEST !== "1" || process.platform !== "linux")("real universal Linux sandbox", () => {
  it("records actual Bash exits, timeout and Abort in durable execution evidence", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    for (const [id, command, code] of [["exit7", "exit 7", 7], ["false", "false", 1]] as const) {
      await expect(bash(cwd, command, id)).rejects.toThrow(`code ${code}`);
      const record = (await executionRepository.list(cwd)).find((entry) => entry.correlation?.tool_call_id === id);
      expect(record).toMatchObject({ status: "failed", result: { exit_code: code } });
    }
    await expect(bash(cwd, "sleep 30", "timeout", undefined, 0.5)).rejects.toThrow(/timed out/);
    expect((await executionRepository.list(cwd)).find((entry) => entry.correlation?.tool_call_id === "timeout")).toMatchObject({ status: "timed_out", result: { execution_error_code: "timeout" } });
    const controller = new AbortController();
    const tool = sandboxBashTool({ cwd, sessionId: "session" });
    await expect(tool.execute("abort", { command: "echo abort-ready; sleep 30" }, (update) => {
      if (update.content.some((part) => part.type === "text" && part.text.includes("abort-ready"))) controller.abort();
    }, { env: new NodeExecutionEnv({ cwd }) }, invocation("abort"), { ...BACKGROUND_CONTEXT, abortSignal: controller.signal })).rejects.toThrow();
    expect((await executionRepository.list(cwd)).find((entry) => entry.correlation?.tool_call_id === "abort")).toMatchObject({ status: "cancelled" });
  }, 30_000);
  it("runs Bash without a skill, keeps child commands isolated and records policy evidence", async () => {
    const cwd = await fixture(); vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "host-secret");
    const result = await bash(cwd, "set -e; cat data.txt; printf output > result.txt; test -z \"$OPENAI_API_KEY\"; if grep SECRET token.json; then exit 44; fi; if cat .pi-science/secret; then exit 44; fi; if cat research/evaluator/secret; then exit 44; fi; bash -c 'test ! -r /etc/passwd'; echo isolated");
    expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("isolated") })]);
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("output");
    expect((await executionRepository.list(cwd))[0]?.runtime).toMatchObject({ execution_mode: "required", sandbox_policy_id: expect.any(String) });
    expect((await executionRepository.list(cwd))[0]?.artifacts).toHaveLength(1);
  }, 30_000);
  it("preserves multi-cell Python state, streams output, blocks secrets/network and environment writes", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required"); vi.stubEnv("OPENAI_API_KEY", "host-secret");
    const cwd = await fixture(); const manager = new NodeKernelManager(); managers.push(manager);
    const options = { cwd, language: "python" as const, environment: environment(cwd), environmentRevisionId: "rev", notebookId: "notebook", timeoutMs: 10_000 };
    expect(await manager.execute({ ...options, code: "value=40\nprint('ready')" })).toMatchObject({ ok: true, stdout: "ready\n" });
    const streams: string[] = [];
    expect(await manager.execute({ ...options, code: "print(value+2)", onEvent: (event) => streams.push(event.text) })).toMatchObject({ ok: true, stdout: "42\n" });
    expect(streams.join("")).toContain("42");
    const probe = `import os,socket\nassert 'OPENAI_API_KEY' not in os.environ\nfor p in ['.pi-science/secret','research/evaluator/secret','/etc/passwd']:\n try: open(p); raise AssertionError(p)\n except OSError: pass\ntry: assert 'SECRET' not in open('token.json').read()\nexcept OSError: pass\ntry: socket.create_connection(('1.1.1.1',443),timeout=.2); raise AssertionError('network')\nexcept OSError: pass\ntry: open(${JSON.stringify(join(options.environment.prefix, "forbidden.txt"))},'w'); raise AssertionError('environment write')\nexcept OSError: pass\nprint('isolated')`;
    expect(await manager.execute({ ...options, code: probe })).toMatchObject({ ok: true, stdout: "isolated\n" });
    const firstId = manager.status().sessions[0]!.sandboxPolicyId;
    const policy = await workspacePolicy(cwd, "rev");
    const narrower = identifyPolicy({ ...policy, denyPaths: [...policy.denyPaths, join(cwd, "data.txt")] });
    expect(await manager.execute({ ...options, sandboxPolicy: narrower, code: "'value' in globals()" })).toMatchObject({ ok: true, result: "False" });
    expect(manager.status().sessions[0]!.sandboxPolicyId).not.toBe(firstId);
    expect(manager.status().active_count).toBe(1);
  }, 30_000);
  it("interrupts the real kernel and destroys a SIGINT-resistant cell on timeout", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const cwd = await fixture(); const manager = new NodeKernelManager(); managers.push(manager);
    const options = { cwd, language: "python" as const, environment: environment(cwd), notebookId: "interrupt", timeoutMs: 200 };
    await manager.execute({ ...options, code: "state=7", timeoutMs: 10_000 });
    expect(await manager.execute({ ...options, code: "while True: pass" })).toMatchObject({ interrupted: true });
    expect(await manager.execute({ ...options, code: "state" })).toMatchObject({ result: "7" });
    await expect(manager.execute({ ...options, code: "import signal\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nwhile True: pass" })).rejects.toThrow("timed out");
    expect(manager.status().active_count).toBe(0);
    expect(await manager.execute({ ...options, code: "2+3", timeoutMs: 10_000 })).toMatchObject({ result: "5" });
  }, 30_000);
  it("removes detached descendants on Bash Abort and persistent-kernel shutdown", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const cwd = await fixture(); const controller = new AbortController();
    const descendant = "import time,pathlib,signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(1.5); pathlib.Path('leaked.txt').write_text('escaped')";
    const code = `import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-I','-c',${JSON.stringify(descendant)}],start_new_session=True)\nprint('ready',flush=True)\ntime.sleep(30)`;
    const { shellQuote } = await import("./process.js");
    await expect(sandboxBashTool({ cwd, sessionId: "owner" }).execute("descendants", { command: `python3 -I -c ${shellQuote(code)}` }, (update) => {
      if (update.content.some((part) => part.type === "text" && part.text.includes("ready"))) controller.abort();
    }, { env: new NodeExecutionEnv({ cwd }) }, invocation("descendants"), { ...BACKGROUND_CONTEXT, abortSignal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    const manager = new NodeKernelManager(); managers.push(manager);
    expect(await manager.execute({ cwd, language: "python", environment: environment(cwd), code: code.replace("time.sleep(30)", ""), timeoutMs: 10_000 })).toMatchObject({ ok: true, stdout: "ready\n" });
    await manager.shutdownAll();
    await new Promise((done) => setTimeout(done, 1800));
    await expect(readFile(join(cwd, "leaked.txt"))).rejects.toThrow();
  }, 15_000);
  it("enforces candidate policy at the HTTP gateway and rejects forged identity/mode parameters", async () => {
    vi.stubEnv("PI_SCIENCE_EXECUTION_MODE", "required");
    const cwd = await fixture(); const directory = join(cwd, "research/study/candidates/one");
    await mkdir(join(directory, "input"), { recursive: true }); await mkdir(join(directory, "work"));
    await writeFile(join(directory, "input/value.txt"), "approved");
    await executionBudgetTools(cwd).tool.execute("budget", { research_id: "study", max_seconds: 60, max_executions: 10 }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation("budget"), BACKGROUND_CONTEXT);
    const identity = { cwd, sessionId: "candidate-worker", budgetOperationId: "op", candidateId: "one", delegatedAgent: "auto-research/experimenter" };
    const grant = candidateKernelGrant(identity, "op", "test-secret");
    const manager = new NodeKernelManager(); managers.push(manager);
    const app = Fastify();
    registerKernelExecutionRoutes(app, { internalToken: "test-secret", upstreamTimeoutMs: 1000 } as ServerConfig, { ensure: async () => environment(cwd) } as unknown as WorkspaceEnvironmentService, manager);
    registerNotebookRoutes(app, {} as NotebookService, "test-secret");
    try {
      const url = `/api/kernels/execute?cwd=${encodeURIComponent(cwd)}`;
      expect((await app.inject({ method: "POST", url, headers: { [SANDBOX_GRANT_HEADER]: grant + "forged" }, payload: { language: "python", code: "1" } })).statusCode).toBe(403);
      const allowed = await app.inject({ method: "POST", url, headers: { [SANDBOX_GRANT_HEADER]: grant }, payload: { language: "python", notebook_id: "same", session_id: "forged-owner", code: "value=41\nprint(open('../input/value.txt').read())\nopen('result.txt','w').write('output')" } });
      expect(allowed.statusCode).toBe(200); expect(allowed.json()).toMatchObject({ ok: true, stdout: "approved\n" });
      const execution = await executionRepository.get(cwd, allowed.json().execution_id);
      expect(execution?.runtime).toMatchObject({ execution_mode: "required", sandbox_policy_id: expect.any(String), environment_revision_id: "test-rev" });
      expect(execution?.files.written.map((entry) => entry.path)).toContain("research/study/candidates/one/work/result.txt");
      const notebookPath = "research/study/candidates/one/work/run.ipynb";
      await writeFile(join(cwd, notebookPath), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { language: "python" } }, cells: [{ id: "a", cell_type: "code", source: "number=40", metadata: {}, outputs: [] }, { id: "b", cell_type: "code", source: "print(number+2)", metadata: {}, outputs: [] }] }));
      vi.stubEnv("PI_SCIENCE_INTERNAL_TOKEN", "test-secret");
      vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
        const parsed = new URL(url);
        const response = await app.inject({ method: (init.method ?? "GET") as "GET" | "POST", url: parsed.pathname + parsed.search, headers: Object.fromEntries(new Headers(init.headers)), ...(init.body ? { payload: String(init.body) } : {}) });
        return new Response(response.body, { status: response.statusCode, headers: response.headers as HeadersInit });
      });
      const notebook = notebookHarnessTools(cwd, identity.sessionId, identity).find((tool) => tool.name === "notebook_run")!;
      const result = await notebook.execute("notebook", { path: notebookPath, cell_ids: ["a", "b"] }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation("notebook"), BACKGROUND_CONTEXT);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(await readFile(join(cwd, notebookPath), "utf8")).cells[1].outputs).toEqual([expect.objectContaining({ output_type: "stream", text: "42\n" })]);
      const blocked = await app.inject({ method: "POST", url, payload: { language: "python", notebook_id: "same", session_id: "forged-owner", source: "agent", sandboxPolicy: { mode: "trusted-host" }, code: "open('research/study/candidates/one/input/value.txt').read()" } });
      expect(blocked.json().ok).toBe(false);
      const candidateBash = sandboxBashTool(identity);
      const run = (id: string, command: string, context = BACKGROUND_CONTEXT) => candidateBash.execute(id, { command }, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation(id), context);
      expect((await run("candidate", "python3 -I -c \"print(open('../input/value.txt').read())\"; ! cat ../../../evaluator/secret")).content).toEqual([expect.objectContaining({ text: expect.stringContaining("approved") })]);
      const controller = new AbortController(); setTimeout(() => controller.abort(), 300);
      await expect(run("abort", "python3 -I -c 'while True: pass'", { ...BACKGROUND_CONTEXT, abortSignal: controller.signal })).rejects.toThrow();
      await manager.shutdownOwner(cwd, identity.sessionId);
      expect(manager.status().sessions.some((session) => session.sessionId === identity.sessionId)).toBe(false);
    } finally { await app.close(); }
  }, 30_000);
});
