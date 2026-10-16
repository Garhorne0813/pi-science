import { readSandboxFile, sandboxArtifactCapture } from "../../sandbox/artifacts.js";
import { canonicalDirectory, identifyPolicy } from "../../sandbox/policy.js";
import { processSettings, srtCli } from "../../sandbox/settings.js";
import { killSandboxGroup, launcherPath } from "../../sandbox/process.js";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { ok, type AgentHarnessTool, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { z } from "zod";
import { withFileWriteLock, workspaceFile } from "../../../storage/persistence.js";
import { executionIdFor, executionRepository } from "../../executions/execution-repository.js";
import { publishWorkspaceArtifacts } from "../../artifacts/workspace-artifact-publisher.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
export const CANDIDATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const inputSchema = z.object({ candidate_id: z.string().regex(CANDIDATE_PATTERN), code: z.string().min(1).max(64 * 1024), timeout_seconds: z.number().int().min(1).max(120).optional() }).strict();
const MAX_LOG_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const producer = "sandbox_run";
class InvalidSandboxOutput extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => path !== root && !relative(root, path).startsWith("..") && !isAbsolute(relative(root, path));
export interface SandboxIdentity { cwd: string; sessionId: string; budgetOperationId?: string; candidateId?: string; delegatedAgent?: string }
export interface SandboxInstallation { python: string; pythonRoot: string; socat?: string; ripgrep?: string }
export interface SandboxProcessResult { status: "succeeded" | "failed" | "cancelled" | "timed_out"; exit_code: number | null; stdout: string; stderr: string; limitations: string[] }

/** Only server operator configuration, never workspace settings, task text or child environment. */
export function sandboxInstallation(): SandboxInstallation | undefined {
  if (process.env.PI_SCIENCE_SANDBOX_ENABLED !== "1" || process.platform !== "linux") return undefined;
  if (!process.env.PI_SCIENCE_SANDBOX_PYTHON || !process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT) throw new Error("Sandbox requires a trusted preinstalled Python and Python root");
  return { python: process.env.PI_SCIENCE_SANDBOX_PYTHON, pythonRoot: process.env.PI_SCIENCE_SANDBOX_PYTHON_ROOT,
    ...(process.env.PI_SCIENCE_SANDBOX_RIPGREP ? { ripgrep: process.env.PI_SCIENCE_SANDBOX_RIPGREP } : {}),
    ...(process.env.PI_SCIENCE_SANDBOX_SOCAT ? { socat: process.env.PI_SCIENCE_SANDBOX_SOCAT } : {}) };
}

/** No aliases or symlink components are accepted for candidate data. Hard links are also excluded. */
async function validateTree(root: string, limit = 4096): Promise<void> {
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (++entries > limit) throw new InvalidSandboxOutput("Sandbox candidate tree exceeds entry limit");
      const file = join(path, item.name); const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new InvalidSandboxOutput("Sandbox candidate contains links or special files");
      if (info.isDirectory()) await visit(file);
    }
  };
  await visit(root);
}
async function boundCandidate(identity: SandboxIdentity, operationId: string, candidateId: string) {
  if (!CANDIDATE_PATTERN.test(candidateId)) throw new Error("Invalid candidate_id");
  if (identity.delegatedAgent && identity.candidateId !== candidateId) throw new Error("Candidate is not authorized for this child");
  const owner = identity.budgetOperationId ?? operationId;
  const binding = z.object({ researchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) }).strict()
    .parse(JSON.parse(await readFile(workspaceFile(identity.cwd, `execution-budget-scopes/${hash(owner)}.json`), "utf8")));
  // A research ID is one literal component, including rejection of '.' and '..'.
  if ([".", ".."].includes(binding.researchId)) throw new Error("Invalid research identity");
  await canonicalDirectory(identity.cwd);
  const directory = await canonicalDirectory(join(identity.cwd, "research", binding.researchId, "candidates", candidateId));
  const input = await canonicalDirectory(join(directory, "input"));
  const work = await canonicalDirectory(join(directory, "work"));
  await validateTree(input);
  return { directory, input, work, researchId: binding.researchId };
}
export async function sandboxCandidate(identity: SandboxIdentity, operationId: string, candidateId: string) {
  const candidate = await boundCandidate(identity, operationId, candidateId);
  await validateTree(candidate.work);
  return candidate;
}

/** Keep the Experimenter's existing read capability inside its assigned candidate as well. */
export function candidateReadTool(original: Tool, identity: SandboxIdentity): Tool {
  if (!identity.candidateId && identity.delegatedAgent !== "auto-research/experimenter") return original;
  return { ...original, async execute(id, params, update, ctx, invocation, context) {
    if (!identity.candidateId) throw new Error("Experimenter read requires a bound candidate_id; use supplied task text for code generation");
    const candidate = await sandboxCandidate(identity, invocation.operationId, identity.candidateId!);
    const lock = workspaceFile(identity.cwd, `sandbox-candidates/${hash(candidate.directory)}.json`);
    return withFileWriteLock(lock, async () => {
      context.abortSignal?.throwIfAborted();
      await sandboxCandidate(identity, invocation.operationId, identity.candidateId!);
      const values = params as { path: string };
      const path = resolve(identity.cwd, values.path);
      if ((!inside(candidate.input, path) && !inside(candidate.work, path)) || await realpath(path) !== path) throw new Error("Read is outside the assigned candidate");
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_ARTIFACT_BYTES) throw new Error("Candidate read requires a bounded regular file");
      const policy = identifyPolicy({ mode: "required", scope: "candidate", cwd: candidate.work, readPaths: [candidate.input, candidate.work], writePaths: [candidate.work], denyPaths: [], network: { mode: "none" } });
      if (process.platform !== "linux") return original.execute(id, { ...values, path }, update, ctx, invocation, context);
      const bytes = await readSandboxFile(policy, path);
      const env = new Proxy(ctx.env, { get(target, property) {
        if (property === "readBinaryFile") return async (requested: string) => { if (resolve(identity.cwd, requested) !== path) throw new Error("Read is outside the assigned candidate"); return ok(bytes); };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      return original.execute(id, { ...values, path }, update, { ...ctx, env }, invocation, context);
    });
  } };
}

export async function sandboxSettings(installation: SandboxInstallation, cwd: string, input: string, work: string) {
  if (process.platform !== "linux") throw new Error("Sandbox execution is disabled on this platform: macOS descendant cleanup has not passed acceptance; use code-generation mode");
  if (!isAbsolute(installation.python) || !isAbsolute(installation.pythonRoot)) throw new Error("Trusted Python paths must be absolute");
  const python = await realpath(installation.python); const pythonRoot = await realpath(installation.pythonRoot);
  if (!inside(pythonRoot, python) || pythonRoot === "/" || ["/usr", "/opt", "/home", "/Users", "/usr/local"].includes(pythonRoot) || inside(cwd, pythonRoot) || inside(pythonRoot, cwd)) throw new Error("Python root must be a dedicated trusted environment outside the workspace");
  await access(python, constants.X_OK);
  const policy = identifyPolicy({ mode: "required", scope: "candidate", cwd: work, readPaths: [input, work], writePaths: [work], denyPaths: [], network: { mode: "none" } });
  return { python, policy, settings: await processSettings(policy, [pythonRoot], installation) };
}

/** Fixed argv, no shell input. The srt CLI quotes argv before its internal OS wrapper. */
export async function runSandboxProcess(settings: string, python: string, work: string, timeoutSeconds: number, signal?: AbortSignal): Promise<SandboxProcessResult> {
  if (process.platform !== "linux") throw new Error("Sandbox execution is disabled on this platform");
  signal?.throwIfAborted();
  const manifest = join(dirname(settings), "launch.json");
  const runtime = join(work, ".runtime");
  await writeFile(manifest, JSON.stringify({ cli: srtCli, settings, argv: [python, "-I", "-B", join(work, "main.py")], timeoutSeconds,
    env: { PATH: "/usr/bin:/bin", HOME: runtime, TMPDIR: runtime, TMP: runtime, TEMP: runtime, XDG_CACHE_HOME: runtime, LANG: "C.UTF-8", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" } }), { mode: 0o600 });
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [launcherPath, manifest], {
      cwd: work, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { PATH: "/usr/bin:/bin", HOME: dirname(settings), TMPDIR: dirname(settings), TMP: dirname(settings), TEMP: dirname(settings),
        XDG_CACHE_HOME: join(work, ".runtime"), LANG: "C.UTF-8", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
    });
    let status: SandboxProcessResult["status"] | undefined;
    const logs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; const limitations: string[] = [];
    const kill = () => killSandboxGroup(child.pid);
    const abort = () => { status ??= signal?.reason instanceof Error && signal.reason.message === "Execution time budget exhausted" ? "timed_out" : "cancelled"; kill(); };
    const timer = setTimeout(() => { status ??= "timed_out"; kill(); }, timeoutSeconds * 1000);
    for (const stream of ["stdout", "stderr"] as const) child[stream]!.on("data", (chunk: Buffer) => {
      const remaining = MAX_LOG_BYTES - logs[stream].length;
      if (chunk.length > remaining && !limitations.includes(`${stream} truncated`)) limitations.push(`${stream} truncated`);
      if (remaining > 0) logs[stream] = Buffer.concat([logs[stream], chunk.subarray(0, remaining)]);
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (error) => { cleanup(); kill(); reject(error); });
    child.once("close", (code) => { cleanup(); kill(); resolveRun({ status: status ?? (code === 0 ? "succeeded" : "failed"), exit_code: code,
      stdout: logs.stdout.toString("utf8"), stderr: logs.stderr.toString("utf8"), limitations }); });
  });
}

async function outputFiles(work: string): Promise<string[]> {
  await validateTree(work);
  // Only bounded top-level scientific data, logs and source; no active HTML/SVG or runtime caches.
  const paths: string[] = []; let bytes = 0;
  for (const entry of (await readdir(work)).sort()) {
    if (!/\.(?:py|json|csv|tsv|txt|log|png|pdf|npy|npz)$/.test(entry)) continue;
    const path = join(work, entry); const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) throw new InvalidSandboxOutput("Unsafe sandbox output");
    bytes += info.size;
    if (paths.length >= 16 || bytes > MAX_ARTIFACT_BYTES) throw new InvalidSandboxOutput("Sandbox artifact limit exceeded");
    paths.push(path);
  }
  return paths;
}

export function sandboxRunTool(identity: SandboxIdentity, installation: SandboxInstallation | undefined): Tool {
  return { name: "sandbox_run", label: "Legacy sandboxed Python", description: "Legacy compatibility for existing sandbox_run workflows and durable invocation recovery. For new work use bash for CLI/Python scripts or notebook_run for stateful Python; do not use this as a fallback after their isolation fails. All calls require a bound candidate/research budget and Parent-prepared input/work; new execution also requires operator-enabled srt. Invalid prior outputs reset all work files; input is preserved and the reset is reported. Process success is a local observation, never official evaluation.",
    parameters: Type.Object({ candidate_id: Type.String({ pattern: CANDIDATE_PATTERN.source }), code: Type.String({ minLength: 1, maxLength: 64 * 1024 }), timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) }),
    async execute(_id, params, _update, _ctx, invocation, context) {
      const values = inputSchema.parse(params);
      if (Buffer.byteLength(values.code) > 64 * 1024) throw new Error("Sandbox code exceeds byte limit");
      context.abortSignal?.throwIfAborted();
      const candidate = await boundCandidate(identity, invocation.operationId, values.candidate_id);
      const executionId = executionIdFor(producer, identity.sessionId, invocation.operationId, invocation.invocationId);
      const lock = workspaceFile(identity.cwd, `sandbox-candidates/${hash(candidate.directory)}.json`);
      return withFileWriteLock(lock, async () => {
        context.abortSignal?.throwIfAborted();
        const cached = await executionRepository.get(identity.cwd, executionId);
        if (cached) {
          if (cached.request.code_sha256 !== hash(values.code) || cached.correlation.candidate_id !== values.candidate_id) throw new Error("Sandbox invocation identity was reused with different input");
          if (cached.status === "running" || cached.status === "pending") await executionRepository.finish(identity.cwd, executionId, { status: "lost", producer,
            result: { execution_id: executionId, candidate_id: values.candidate_id, status: "lost", exit_code: null, duration_ms: null, stdout: "", stderr: "Worker completion is unknown; this invocation will not be replayed", artifact_refs: [], limitations: ["Inspect candidate state before starting a new invocation"] } });
          const record = (await executionRepository.get(identity.cwd, executionId))!;
          return { content: [{ type: "text", text: JSON.stringify(record.result) }], details: record.result };
        }
        // Read-only recovery must not require an enabled/installed executor.
        // Candidate authorization and invocation/input identity still apply.
        if (!installation) throw new Error("Sandbox unavailable; return code-generation output. Never run Python on the host as fallback.");
        const configured = await sandboxSettings(installation, identity.cwd, candidate.input, candidate.work);
        await invocation.setMemo("sandbox-execution-id", executionId);
        const started = Date.now();
        await executionRepository.start(identity.cwd, { execution_id: executionId, kind: "tool", surface: "python", producer,
          correlation: { session_id: identity.sessionId, operation_id: invocation.operationId, tool_call_id: invocation.invocationId, candidate_id: values.candidate_id, turn_id: invocation.turnId },
          request: { candidate_id: values.candidate_id, research_id: candidate.researchId, code_sha256: hash(values.code), code: values.code, timeout_seconds: values.timeout_seconds ?? 60 },
          runtime: { sandbox: "@anthropic-ai/sandbox-runtime@0.0.79", sandbox_policy_id: configured.policy.id, execution_mode: configured.policy.mode, platform: process.platform, python: configured.python } });
        let temporary: string | undefined;
        let result: Record<string, unknown>;
        let processResult: SandboxProcessResult | undefined;
        const limitations: string[] = [];
        try {
          // Revalidate under the candidate lock before touching code or launching a process.
          await boundCandidate(identity, invocation.operationId, values.candidate_id);
          let previousPaths: string[];
          try { previousPaths = await outputFiles(candidate.work); } catch (error) {
            if (!(error instanceof InvalidSandboxOutput)) throw error;
            // No untrusted process is running under this lock. Reset only canonical work;
            // rm unlinks symlinks without traversing their targets. Input is never cleaned.
            await canonicalDirectory(candidate.work);
            for (const entry of await readdir(candidate.work)) await rm(join(candidate.work, entry), { recursive: true, force: true });
            previousPaths = await outputFiles(candidate.work);
            limitations.push(`Invalid candidate work reset before execution; previous work outputs removed: ${error.message}`);
          }
          const previousOutputs = new Map<string, string>();
          for (const path of previousPaths) previousOutputs.set(path, createHash("sha256").update(await readSandboxFile(configured.policy, path)).digest("hex"));
          const runtime = join(candidate.work, ".runtime"); await mkdir(runtime, { recursive: true }); await canonicalDirectory(runtime);
          const code = await open(join(candidate.work, "main.py"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
          try { await code.writeFile(values.code); } finally { await code.close(); }
          // Short private control paths avoid Unix socket path limits in srt. Never exposed to Python.
          temporary = await mkdtemp(join(await realpath(process.platform === "darwin" ? "/private/tmp" : "/tmp"), "ps-"));
          const settingsPath = join(temporary, "settings.json"); await writeFile(settingsPath, JSON.stringify(configured.settings), { mode: 0o600 });
          processResult = await runSandboxProcess(settingsPath, configured.python, candidate.work, values.timeout_seconds ?? 60, context.abortSignal);
          processResult.limitations.unshift(...limitations);
          const artifact_refs = [];
          if (processResult.status === "succeeded" || processResult.status === "failed") {
            const changed: string[] = [];
            for (const path of await outputFiles(candidate.work)) {
              const digest = createHash("sha256").update(await readSandboxFile(configured.policy, path)).digest("hex");
              if (path === join(candidate.work, "main.py") || previousOutputs.get(path) !== digest) changed.push(relative(identity.cwd, path));
            }
            const published = await publishWorkspaceArtifacts(identity.cwd, changed, { tool: producer, executionId, sessionId: identity.sessionId, captureFile: sandboxArtifactCapture(identity.cwd, configured.policy) });
            artifact_refs.push(...published.map((artifact) => ({ ...artifact, relation: "output" as const })));
          }
          result = { execution_id: executionId, candidate_id: values.candidate_id, ...processResult, duration_ms: Date.now() - started, artifact_refs };
        } catch (error) {
          result = { execution_id: executionId, candidate_id: values.candidate_id, status: context.abortSignal?.aborted ? "cancelled" : "failed", exit_code: processResult?.exit_code ?? null,
            stdout: processResult?.stdout ?? "", stderr: [processResult?.stderr, String(error)].filter(Boolean).join("\n"), duration_ms: Date.now() - started, artifact_refs: [], limitations: [...(processResult?.limitations ?? limitations), "Execution or output publication failed; no host execution fallback"] };
        } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
        await executionRepository.finish(identity.cwd, executionId, { status: result.status as SandboxProcessResult["status"], producer, result,
          artifacts: result.artifact_refs as Array<{ artifact_id: string; version: number; relation: "output" }> });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      });
    },
  };
}
