import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT, type AgentHarnessToolInvocation, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { sandboxCandidate, sandboxRunTool, sandboxSettings, candidateReadTool, sandboxInstallation, type SandboxInstallation, type SandboxIdentity } from "./sandbox-tool.js";
import { executionBudgetTools } from "./execution-budget.js";
import { executionIdFor, executionRepository } from "../../executions/execution-repository.js";
import { workspaceFile } from "../../../storage/persistence.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const env = { env: {} as NodeExecutionEnv };
function invocation(id: string): AgentHarnessToolInvocation { const memo = new Map(); return { operationId: "owner", invocationId: id, turnId: "turn", getMemo: async (key) => memo.get(key), setMemo: async (key, value) => { memo.set(key, value); } }; }
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "sandbox-[tool]-"))); roots.push(cwd);
  await mkdir(join(cwd, ".pi-science"));
  const directory = join(cwd, "research/study-1/candidates/candidate-001");
  await mkdir(join(directory, "input"), { recursive: true }); await mkdir(join(directory, "work"));
  const budget = executionBudgetTools(cwd);
  await budget.tool.execute("setup", { research_id: "study-1", max_seconds: 120, max_executions: 30 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  const identity: SandboxIdentity = { cwd, sessionId: "session", budgetOperationId: "owner", delegatedAgent: "auto-research/experimenter", candidateId: "candidate-001" };
  return { cwd, directory, budget, identity };
}
const execute = (tool: ReturnType<typeof sandboxRunTool>, id: string, code: string, context = BACKGROUND_CONTEXT, timeout_seconds = 10) => tool.execute(id, { candidate_id: "candidate-001", code, timeout_seconds }, () => {}, env, invocation(id), context);

it.each(["succeeded", "failed", "cancelled", "timed_out", "lost"] as const)("recovers a historical %s result without an executor and refuses changed input or a new invocation", async (status) => {
  const { identity, cwd } = await fixture(); const code = "raise RuntimeError('must not run')";
  const executionId = executionIdFor("sandbox_run", "session", "owner", "historical");
  await executionRepository.start(cwd, { execution_id: executionId, kind: "tool", surface: "python", producer: "sandbox_run", correlation: { candidate_id: "candidate-001" }, request: { code_sha256: createHash("sha256").update(code).digest("hex") } });
  const result = { execution_id: executionId, status, stdout: "historical output", artifact_refs: [{ artifact_id: "historical-artifact", version: 2 }] };
  await executionRepository.finish(cwd, executionId, { status, producer: "sandbox_run", result });
  const tool = sandboxRunTool(identity, undefined);
  expect((await execute(tool, "historical", code)).details).toEqual(result);
  await expect(execute(tool, "historical", "print('changed')")).rejects.toThrow("different input");
  await expect(execute(tool, "new", code)).rejects.toThrow("Sandbox unavailable");
  await expect(execute(sandboxRunTool({ ...identity, candidateId: "other" }, undefined), "historical", code)).rejects.toThrow("not authorized");
  expect(await executionRepository.list(cwd)).toHaveLength(1);
});

it("reconciles only the identical unfinished legacy invocation as lost with execution disabled", async () => {
  const { identity, cwd } = await fixture(); const code = "print('must not replay')";
  const id = executionIdFor("sandbox_run", "session", "owner", "unfinished");
  await executionRepository.start(cwd, { execution_id: id, kind: "tool", surface: "python", producer: "sandbox_run", correlation: { candidate_id: "candidate-001" }, request: { code_sha256: createHash("sha256").update(code).digest("hex") } });
  const tool = sandboxRunTool(identity, undefined);
  await expect(execute(tool, "another-invocation", code)).rejects.toThrow("Sandbox unavailable");
  expect((await executionRepository.get(cwd, id))?.status).toBe("running");
  expect((await execute(tool, "unfinished", code)).details).toMatchObject({ status: "lost", stdout: "" });
  expect((await executionRepository.get(cwd, id))?.status).toBe("lost");
  expect(await executionRepository.list(cwd)).toHaveLength(1);
});

it("refuses disabled execution, invalid paths, unknown candidate and unassigned children", async () => {
  const { identity } = await fixture();
  await expect(execute(sandboxRunTool(identity, undefined), "disabled", "print(1)")).rejects.toThrow("Sandbox unavailable");
  for (const id of ["../candidate-001", "/tmp", ".", "a/b", "a.b", "a\\b"]) await expect(sandboxCandidate(identity, "owner", id)).rejects.toThrow("Invalid candidate");
  await expect(sandboxCandidate(identity, "owner", "candidate-002")).rejects.toThrow("not authorized");
  await expect(sandboxCandidate({ ...identity, candidateId: undefined }, "owner", "candidate-001")).rejects.toThrow("not authorized");
  await expect(sandboxCandidate({ ...identity, budgetOperationId: "missing" }, "owner", "candidate-001")).rejects.toThrow();
});
it("rejects malformed tool inputs before execution or record creation", async () => {
  const { identity, cwd } = await fixture(); const tool = sandboxRunTool(identity, undefined);
  for (const params of [
    { candidate_id: "candidate-001", code: "print(1)", timeout_seconds: 121 },
    { candidate_id: "candidate-001", code: "x".repeat(65537) },
    { candidate_id: "candidate-001", code: "字".repeat(30000) },
    { candidate_id: "candidate-001", code: "print(1)", command: "bash" },
  ]) await expect(tool.execute("invalid", params, () => {}, env, invocation("invalid"), BACKGROUND_CONTEXT)).rejects.toThrow();
  expect(await executionRepository.list(cwd)).toEqual([]);
});
it("rejects candidate symlinks, workspace aliases, input hard links and special output links", async () => {
  const { identity, cwd, directory } = await fixture();
  const alias = join(cwd, "alias"); await symlink(directory, alias);
  await expect(sandboxCandidate({ ...identity, cwd: alias }, "owner", "candidate-001")).rejects.toThrow();
  await writeFile(join(cwd, "secret"), "SECRET"); await link(join(cwd, "secret"), join(directory, "input/linked"));
  await expect(sandboxCandidate(identity, "owner", "candidate-001")).rejects.toThrow("links");
  await rm(join(directory, "input/linked")); await symlink(join(cwd, "secret"), join(directory, "work/linked"));
  await expect(sandboxCandidate(identity, "owner", "candidate-001")).rejects.toThrow("links");
});
it("restricts the assigned child's read tool to regular candidate files", async () => {
  const { identity, directory, budget } = await fixture();
  const read = candidateReadTool({ ...budget.tool, name: "read", execute: async () => ({ content: [], details: { allowed: true } }) }, identity);
  const call = (path: string) => read.execute("read", { path }, () => {}, env, invocation("read"), BACKGROUND_CONTEXT);
  await expect(call("research/study-1/evaluation.yaml")).rejects.toThrow("outside");
  await writeFile(join(directory, "input/data.txt"), "data"); expect((await call(join(directory, "input/data.txt"))).details).toEqual({ allowed: true });
});
it.skipIf(process.platform !== "linux")("keeps an authorized read pinned when an idle kernel swaps its path for an evaluator link", async () => {
  const { identity, directory, budget, cwd } = await fixture();
  const path = join(directory, "work/read.txt"); const secret = join(cwd, "research/study-1/secret.txt");
  await writeFile(path, "approved"); await writeFile(secret, "EVALUATOR SECRET");
  const original = { ...budget.tool, name: "read", async execute(_id: string, _params: unknown, _update: unknown, ctx: { env: NodeExecutionEnv }) {
    await rm(path); await symlink(secret, path);
    const read = await ctx.env.readBinaryFile(path, BACKGROUND_CONTEXT);
    if (!read.ok) throw read.error;
    return { content: [{ type: "text" as const, text: Buffer.from(read.value).toString("utf8") }], details: {} };
  } };
  const result = await candidateReadTool(original, identity).execute("read", { path }, () => {}, env, invocation("read"), BACKGROUND_CONTEXT);
  expect(result.content).toEqual([{ type: "text", text: "approved" }]);
});
it.each(["0", "1"])("refuses unbound Experimenter reads even with sandbox enable flag %s", async (enabled) => {
  vi.stubEnv("PI_SCIENCE_SANDBOX_ENABLED", enabled);
  const { identity, budget } = await fixture();
  const execute = vi.fn(); const original = { ...budget.tool, name: "read", execute };
  const read = candidateReadTool(original, { ...identity, candidateId: undefined });
  for (const path of ["research/study-1/evaluation.yaml", "research/study-1/evaluator/hidden.json", "research/study-1/candidates/candidate-002/work/data.txt"])
    await expect(read.execute("read", { path }, () => {}, env, invocation("read"), BACKGROUND_CONTEXT)).rejects.toThrow("bound candidate_id");
  expect(execute).not.toHaveBeenCalled();
  expect(candidateReadTool(original, { ...identity, delegatedAgent: "auto-research/reviewer", candidateId: undefined })).toBe(original);
});
it.skipIf(process.platform !== "linux")("uses a root read deny and never accepts workspace Python or a broad Python root", async () => {
  const { cwd } = await fixture();
  await expect(sandboxSettings({ python: process.execPath, pythonRoot: "/" }, cwd, "/input", "/work")).rejects.toThrow("dedicated");
  await mkdir(join(cwd, "python")); await writeFile(join(cwd, "python/python"), "bad");
  await expect(sandboxSettings({ python: join(cwd, "python/python"), pythonRoot: join(cwd, "python") }, cwd, "/input", "/work")).rejects.toThrow("dedicated");
});

it.skipIf(process.platform === "linux")("keeps macOS and Windows in code-generation mode even when an operator enables execution", async () => {
  vi.stubEnv("PI_SCIENCE_SANDBOX_ENABLED", "1"); vi.stubEnv("PI_SCIENCE_SANDBOX_PYTHON", "/trusted/python"); vi.stubEnv("PI_SCIENCE_SANDBOX_PYTHON_ROOT", "/trusted");
  expect(sandboxInstallation()).toBeUndefined();
  const { identity, cwd } = await fixture();
  await expect(execute(sandboxRunTool(identity, undefined), "blocked", "print('unsafe')")).rejects.toThrow("Sandbox unavailable");
  // A direct caller cannot bypass the installation gate by supplying its own configuration.
  await expect(execute(sandboxRunTool(identity, { python: "/trusted/python", pythonRoot: "/trusted" }), "bypass", "print('unsafe')")).rejects.toThrow("disabled on this platform");
  expect(await executionRepository.list(cwd)).toEqual([]);
});

const realSandbox = process.env.PI_SCIENCE_SANDBOX_TEST === "1";
describe.skipIf(!realSandbox || process.platform !== "linux")("real srt isolation (no mocks)", () => {
  const installation: SandboxInstallation = { python: process.env.PI_SCIENCE_SANDBOX_PYTHON!, pythonRoot: process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT!, socat: process.env.PI_SCIENCE_SANDBOX_SOCAT, ripgrep: process.env.PI_SCIENCE_SANDBOX_RIPGREP };
  it("runs NumPy, publishes real artifacts, repairs errors, and replays without executing again", async () => {
    const { identity, cwd, directory } = await fixture(); const tool = sandboxRunTool(identity, installation);
    await writeFile(join(directory, "work/stale.json"), "{};");
    const failed = await execute(tool, "bad", "raise ValueError('repair-me')"); expect(failed.details).toMatchObject({ status: "failed", stderr: expect.stringContaining("repair-me") });
    const code = "import numpy as np, json\nfrom pathlib import Path\np=Path('count.txt'); p.write_text(p.read_text()+'x' if p.exists() else 'x')\nvalue=float(np.mean([1,2,3])); print(value)\nPath('output.json').write_text(json.dumps({'value':value,'predictions':(np.array([1,2,3])*2).tolist()}))";
    const result = await execute(tool, "good", code); expect(result.details).toMatchObject({ status: "succeeded", stdout: "2.0\n", exit_code: 0, artifact_refs: expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("output.json"), artifact_id: expect.any(String) })]) });
    expect((result.details as { artifact_refs: Array<{ path: string }> }).artifact_refs.some((ref) => ref.path.endsWith("stale.json"))).toBe(false);
    const record = await executionRepository.get(cwd, (result.details as { execution_id: string }).execution_id); expect(record?.status).toBe("succeeded"); expect(record?.artifacts.length).toBeGreaterThan(0);
    expect((await execute(sandboxRunTool(identity, installation), "good", code)).details).toEqual(result.details);
    expect(await readFile(join(cwd, "research/study-1/candidates/candidate-001/work/count.txt"), "utf8")).toBe("x");
    const evaluator = join(cwd, "research/study-1/evaluator"); await mkdir(evaluator);
    await writeFile(join(evaluator, "expected.json"), "[2,4,6]");
    await writeFile(join(evaluator, "score.py"), "import json,sys,pathlib\nexpected=json.loads(pathlib.Path(__file__).with_name('expected.json').read_text())\npred=json.loads(pathlib.Path(sys.argv[1]).read_text())['predictions']\nprint(sum((a-b)**2 for a,b in zip(expected,pred))/len(expected))");
    const evaluated = await promisify(execFile)(installation.python, ["-I", join(evaluator, "score.py"), join(cwd, "research/study-1/candidates/candidate-001/work/output.json")]);
    expect(evaluated.stdout).toBe("0.0\n");
    await expect(execute(tool, "good", "print('changed')")).rejects.toThrow("reused");
  }, 30000);
  it("blocks protected reads/writes, traversal, symlinks, inherited subprocesses and credentials", async () => {
    const { identity, cwd, directory } = await fixture();
    vi.stubEnv("OPENAI_API_KEY", "host-credential-sentinel");
    const protectedPaths = [join(cwd, "research/study-1/evaluation.yaml"), join(cwd, "research/study-1/evaluator/secret"), join(cwd, "research/study-1/candidates/candidate-002/work/secret"), join(cwd, ".pi-science/credential"), join(cwd, "credential"), workspaceFile(cwd, "execution-events-v1.jsonl")];
    for (const path of protectedPaths) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, "SECRET"); }
    // Leave the execution log valid; the sandbox must still be unable to read it.
    await rm(protectedPaths.at(-1)!);
    const code = `import os, pathlib, subprocess, sys\npaths=${JSON.stringify(protectedPaths)}\npaths += ['../../../../evaluation.yaml', '/proc/1/root'+paths[0]]\nfor p in paths:\n try: open(p); raise AssertionError('escaped read '+p)\n except OSError: pass\n # Linux read-deny masks may permit private shadow writes; these must never touch the host.\n try:\n  with open(p,'w') as f: f.write('shadow')\n  os.unlink(p)\n except OSError: pass\nos.symlink(paths[0], 'escape')\ntry: open('escape'); raise AssertionError('symlink escape')\nexcept OSError: pass\nos.unlink('escape')\nr=subprocess.run([sys.executable,'-I','-c',"open("+repr(paths[0])+")"],capture_output=True)\nassert r.returncode != 0\nassert 'OPENAI_API_KEY' not in os.environ\nassert pathlib.Path('../input/data.txt').read_text() == 'input'\ntry: open('../input/data.txt','w'); raise AssertionError('input write escaped')\nexcept OSError: pass\nprint('isolated')`;
    await writeFile(join(directory, "input/data.txt"), "input");
    const result = await execute(sandboxRunTool(identity, installation), "boundary", code); expect(result.details, JSON.stringify(result.details)).toMatchObject({ status: "succeeded", stdout: "isolated\n" });
    for (const path of protectedPaths.slice(0, -1)) expect(await readFile(path, "utf8")).toBe("SECRET");
  }, 15000);
  it("blocks external, loopback and Unix sockets", async () => {
    const { identity, cwd } = await fixture();
    const tcp = createServer((socket) => socket.end("host service")); const unix = createServer((socket) => socket.end("host unix"));
    await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
    const unixPath = join(cwd, "host.sock"); await new Promise<void>((done) => unix.listen(unixPath, done));
    const port = (tcp.address() as { port: number }).port;
    try {
    const result = await execute(sandboxRunTool(identity, installation), "network", `import socket\nfor address in [('1.1.1.1',443),('127.0.0.1',${port})]:\n try:\n  s=socket.create_connection(address,timeout=.3); raise AssertionError('network escaped')\n except OSError: pass\ntry:\n s=socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(unixPath)}); raise AssertionError('unix escaped')\nexcept OSError: pass\nimport urllib.request\nfor url in ['http://127.0.0.1:${port}/','https://example.com/']:\n try: urllib.request.urlopen(url,timeout=.5); raise AssertionError('proxy network escaped')\n except OSError: pass\nimport sys\nif sys.platform == 'linux':\n try: socket.socket(socket.AF_UNIX); raise AssertionError('Unix socket creation escaped seccomp')\n except OSError: pass\nprint('blocked')`);
    expect(result.details).toMatchObject({ status: "succeeded", stdout: "blocked\n" });
    } finally { await Promise.all([new Promise<void>((done) => tcp.close(() => done())), new Promise<void>((done) => unix.close(() => done()))]); }
  }, 15000);
  it("bounds logs and artifacts and refuses linked outputs", async () => {
    const { identity } = await fixture(); const tool = sandboxRunTool(identity, installation);
    const logs = await execute(tool, "logs", "print('x'*200000)"); expect((logs.details as { stdout: string }).stdout.length).toBe(65536); expect(logs.details).toMatchObject({ limitations: ["stdout truncated"] });
    const linked = await execute(tool, "linked", "import os\nos.symlink('/etc/passwd','out.txt')"); expect(linked.details).toMatchObject({ status: "failed", stderr: expect.stringContaining("links") });
  }, 15000);
  it("stops infinite loops on timeout, child Abort and shared budget deadlines", async () => {
    const { identity, cwd } = await fixture(); const tool = sandboxRunTool(identity, installation);
    expect((await execute(tool, "timeout", "while True: pass", BACKGROUND_CONTEXT, 1)).details).toMatchObject({ status: "timed_out" });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 700);
    try { expect((await execute(tool, "abort", "import subprocess,sys\nsubprocess.Popen([sys.executable,'-c','while True: pass'])\nwhile True: pass", { ...BACKGROUND_CONTEXT, abortSignal: controller.signal })).details).toMatchObject({ status: "cancelled" }); } finally { clearTimeout(timer); }
    const budgets = executionBudgetTools(cwd); await budgets.tool.execute("narrow", { max_seconds: 2 }, () => {}, env, invocation("narrow"), BACKGROUND_CONTEXT);
    const result = await execute(budgets.wrap(tool), "budget", "while True: pass"); expect(["cancelled", "timed_out"]).toContain((result.details as { status: string }).status);
  }, 15000);
  it("keeps parallel sandbox calls inside the same durable call allowance", async () => {
    const { identity, cwd } = await fixture();
    const budget = executionBudgetTools(cwd); await budget.tool.execute("narrow", { max_executions: 1 }, () => {}, env, invocation("narrow"), BACKGROUND_CONTEXT);
    const calls = await Promise.allSettled(["a", "b"].map((id) => execute(executionBudgetTools(cwd, "owner").wrap(sandboxRunTool(identity, installation)), id, "print('one')")));
    expect(calls.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await executionRepository.list(cwd)).filter((record) => record.producer === "sandbox_run")).toHaveLength(1);
  }, 15000);
  it("rejects oversized artifact publication without inventing artifact references", async () => {
    const { identity } = await fixture();
    const result = await execute(sandboxRunTool(identity, installation), "oversize", "from pathlib import Path\nPath('large.txt').write_bytes(b'x'*(8*1024*1024+1))");
    expect(result.details).toMatchObject({ status: "failed", artifact_refs: [], stderr: expect.stringContaining("artifact limit") });
  }, 15000);
  it.each(["oversized", "symlink"])("recovers from rejected %s outputs without touching input or link targets", async (kind) => {
    const { identity, directory, cwd } = await fixture(); const tool = sandboxRunTool(identity, installation);
    const protectedDirectory = join(cwd, "research/study-1/evaluator"); await mkdir(protectedDirectory);
    await writeFile(join(protectedDirectory, "secret.txt"), "PROTECTED"); await writeFile(join(directory, "input/data.txt"), "INPUT");
    const code = kind === "oversized" ? "from pathlib import Path\nPath('bad.txt').write_bytes(b'x'*(8*1024*1024+1))"
      : `import os\nos.symlink(${JSON.stringify(protectedDirectory)}, 'bad.txt')`;
    const rejected = await execute(tool, "rejected", code);
    expect(rejected.details).toMatchObject({ status: "failed", artifact_refs: [], stderr: expect.stringContaining(kind === "oversized" ? "artifact limit" : "links") });
    const repaired = await execute(tool, "repair", "from pathlib import Path\nPath('bad.txt').unlink(missing_ok=True)\nassert Path('../input/data.txt').read_text() == 'INPUT'\nPath('repaired.json').write_text('{}')\nprint('repaired')");
    expect(repaired.details).toMatchObject({ status: "succeeded", stdout: "repaired\n", limitations: [expect.stringContaining("Invalid candidate work reset")], artifact_refs: expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining("repaired.json") })]) });
    expect(await readFile(join(protectedDirectory, "secret.txt"), "utf8")).toBe("PROTECTED");
    expect(await readFile(join(directory, "input/data.txt"), "utf8")).toBe("INPUT");
    expect((await execute(tool, "next", "print('next')")).details).toMatchObject({ status: "succeeded", stdout: "next\n", limitations: [] });
    expect((await executionRepository.get(cwd, (rejected.details as { execution_id: string }).execution_id))?.status).toBe("failed");
  }, 20000);
  it("kills detached descendants when the owning Worker process crashes", async () => {
    const { identity, directory } = await fixture();
    const work = join(directory, "work"); await mkdir(join(work, ".runtime"));
    const config = await sandboxSettings(installation, identity.cwd, join(directory, "input"), work);
    const control = await mkdtemp(join(await realpath(process.platform === "darwin" ? "/private/tmp" : "/tmp"), "pst-")); roots.push(control);
    const settings = join(control, "settings.json"); await writeFile(settings, JSON.stringify(config.settings));
    const heartbeat = "import pathlib,time\nwhile True:\n pathlib.Path('heartbeat.txt').write_text(str(time.time_ns())); time.sleep(.05)";
    await writeFile(join(work, "main.py"), `import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-I','-c',${JSON.stringify(heartbeat)}],start_new_session=True)\nwhile True: time.sleep(.1)`);
    const parentScript = join(identity.cwd, "test-worker.mjs");
    const module = fileURLToPath(new URL("./sandbox-tool.ts", import.meta.url));
    await writeFile(parentScript, `import {runSandboxProcess} from ${JSON.stringify(module)}; await runSandboxProcess(${JSON.stringify(settings)},${JSON.stringify(config.python)},${JSON.stringify(work)},30);`);
    const parent = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), parentScript], { stdio: "ignore" });
    try {
      await vi.waitFor(async () => expect((await readFile(join(work, "heartbeat.txt"), "utf8")).length).toBeGreaterThan(0), { timeout: 10000 });
      const exited = new Promise<void>((done) => parent.once("exit", () => done())); parent.kill("SIGKILL"); await exited;
      await new Promise((done) => setTimeout(done, 300));
      const stopped = await readFile(join(work, "heartbeat.txt"), "utf8"); await new Promise((done) => setTimeout(done, 300));
      expect(await readFile(join(work, "heartbeat.txt"), "utf8")).toBe(stopped);
    } finally { parent.kill("SIGKILL"); }
  }, 15000);
  it("marks an unfinished durable invocation lost instead of replaying it", async () => {
    const { identity, cwd } = await fixture(); const code = "print('must not execute')";
    const id = executionIdFor("sandbox_run", "session", "owner", "lost");
    await executionRepository.start(cwd, { execution_id: id, kind: "tool", surface: "python", producer: "sandbox_run", correlation: { candidate_id: "candidate-001" }, request: { code_sha256: createHash("sha256").update(code).digest("hex") } });
    const result = await execute(sandboxRunTool(identity, installation), "lost", code); expect(result.details).toMatchObject({ status: "lost", stdout: "" }); expect((await executionRepository.get(cwd, id))?.status).toBe("lost");
  });
  it("fails closed when the configured sandbox dependency is missing", async () => {
    const { identity } = await fixture();
    await expect(execute(sandboxRunTool(identity, { ...installation, socat: "/nonexistent/socat" }), "missing", "print('unsafe')")).rejects.toThrow("ENOENT");
  }, 15000);
});
