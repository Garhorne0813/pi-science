import { createHash } from "node:crypto";
import { createBashTool, NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { withFileWriteLock, workspaceFile } from "../../../storage/persistence.js";
import { executionIdFor, executionRepository } from "../../executions/execution-repository.js";
import { identifyPolicy, workspacePolicy } from "../../sandbox/policy.js";
import { prepareSandbox, type PreparedSandbox } from "../../sandbox/process.js";
import { bashDependencies, SANDBOX_RUNTIME } from "../../sandbox/settings.js";
import { sandboxCandidate, type SandboxIdentity } from "./sandbox-tool.js";
import { toolEnvironment } from "../agent-runtime-environment.js";
import { snapshotSandboxOutputs, sandboxArtifactCapture } from "../../sandbox/artifacts.js";
import { diffWorkspaceSnapshots } from "../../artifacts/workspace-artifact-snapshot.js";
import { publishWorkspaceArtifactsDetailed } from "../../artifacts/workspace-artifact-publisher.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
/** Keep upstream schema, output capture/checkpoints and result contract. Only replace its OS backend. */
export function sandboxBashTool(identity: SandboxIdentity, hostEnvironment: Record<string, string> = toolEnvironment(process.env)): Tool {
  const original = createBashTool();
  return { ...original, async execute(id, params, update, ctx, invocation, context) {
    const candidate = identity.candidateId ? await sandboxCandidate(identity, invocation.operationId, identity.candidateId) : undefined;
    if (identity.delegatedAgent === "auto-research/experimenter" && !candidate) throw new Error("Candidate execution requires a server-bound candidate");
    const revision = hostEnvironment.PI_SCIENCE_ENVIRONMENT_REVISION_ID;
    const policy = candidate ? identifyPolicy({ mode: "required", scope: "candidate", cwd: candidate.work, readPaths: [candidate.input, candidate.work], writePaths: [candidate.work], denyPaths: [], network: { mode: "none" }, ...(revision ? { environmentRevision: revision } : {}) }) : await workspacePolicy(identity.cwd, revision);
    const values = params as { command: string; timeout?: number };
    const timeout = values.timeout ?? 600;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
    const run = async () => {
      context.abortSignal?.throwIfAborted();
      if (candidate) await sandboxCandidate(identity, invocation.operationId, identity.candidateId!);
      const executionId = executionIdFor("bash", identity.sessionId, invocation.operationId, invocation.invocationId);
      let prepared: PreparedSandbox | undefined;
      let env: NodeExecutionEnv | undefined;
      let started = false;
      let outcome: { exitCode?: number | null; errorCode?: string } = {};
      let before: Awaited<ReturnType<typeof snapshotSandboxOutputs>> | undefined;
      const outputs = async () => {
        await env?.cleanup(context);
        const after = before ? await snapshotSandboxOutputs(identity.cwd, policy) : null;
        const diff = before && after ? diffWorkspaceSnapshots(before, after) : { created: [], modified: [] };
        const entries = [...diff.created, ...diff.modified];
        const published = await publishWorkspaceArtifactsDetailed(identity.cwd, entries.map((entry) => entry.path), { tool: "bash", executionId, sessionId: identity.sessionId,
          ...(policy.mode === "required" ? { captureFile: sandboxArtifactCapture(identity.cwd, policy) } : {}) });
        return { files: { written: entries.map((entry) => ({ path: entry.path, detection: "snapshot" as const })) },
          artifacts: published.artifacts.map((artifact) => ({ artifact_id: artifact.artifact_id, version: artifact.version, relation: "output" as const })), failures: published.failures };
      };
      try {
        if (await executionRepository.get(identity.cwd, executionId)) throw new Error("Bash invocation already recorded; inspect its result before issuing a new invocation");
        await executionRepository.start(identity.cwd, { execution_id: executionId, kind: "tool", surface: "local", producer: "bash", correlation: { session_id: identity.sessionId, operation_id: invocation.operationId, tool_call_id: invocation.invocationId, ...(identity.candidateId ? { candidate_id: identity.candidateId } : {}) },
          request: { command: ["/bin/bash", "-c", values.command], timeout_seconds: Math.min(timeout, 600) }, runtime: { sandbox: policy.mode === "required" ? SANDBOX_RUNTIME : "trusted-host", sandbox_policy_id: policy.id, execution_mode: policy.mode, ...(revision ? { environment_revision_id: revision } : {}) } });
        started = true;
        const dependencies = [...new Set([...(hostEnvironment.PI_SCIENCE_ENVIRONMENT_PREFIX ? [hostEnvironment.PI_SCIENCE_ENVIRONMENT_PREFIX] : []), ...bashDependencies()])];
        prepared = policy.mode === "required" ? await prepareSandbox(policy, ["/bin/bash", "--noprofile", "--norc"], dependencies, Math.min(timeout, 600)) : undefined;
        env = new NodeExecutionEnv({ cwd: policy.cwd, ...(prepared ? { shellPath: prepared.shell } : {}) });
        // Upstream throws on nonzero exits and omits the code from the thrown
        // error. Observe its structured OS result without parsing output text.
        const exec = env.exec.bind(env);
        env.exec = async (...args) => {
          const result = await exec(...args);
          outcome = result.ok ? { exitCode: result.value.exitCode } : { errorCode: result.error.code };
          return result;
        };
        before = await snapshotSandboxOutputs(identity.cwd, policy);
        const safeOriginal = createBashTool({ prepare(execution) { execution.env = prepared?.env ?? toolEnvironment(hostEnvironment); execution.inheritEnv = false; } });
        const result = await safeOriginal.execute(id, { ...values, timeout: Math.min(timeout, 600) }, update, { ...ctx, env }, invocation, context);
        const evidence = await outputs();
        await executionRepository.finish(identity.cwd, executionId, { status: "succeeded", producer: "bash", result: { sandbox_policy_id: policy.id, exit_code: outcome.exitCode,
          output_preview: result.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n").slice(0, 16 * 1024),
          ...(evidence.failures.length ? { artifact_publish_errors: evidence.failures } : {}) }, files: evidence.files, artifacts: evidence.artifacts });
        return result;
      } catch (error) {
        const timedOut = outcome.errorCode === "timeout" || context.abortSignal?.reason instanceof Error && context.abortSignal.reason.message === "Execution time budget exhausted";
        if (started) {
          const evidence = await outputs();
          await executionRepository.finish(identity.cwd, executionId, { status: timedOut ? "timed_out" : outcome.errorCode === "aborted" || context.abortSignal?.aborted ? "cancelled" : "failed", producer: "bash", result: { error: String(error), sandbox_policy_id: policy.id, ...(outcome.exitCode !== undefined ? { exit_code: outcome.exitCode } : {}), ...(outcome.errorCode ? { execution_error_code: outcome.errorCode } : {}),
            ...(evidence.failures.length ? { artifact_publish_errors: evidence.failures } : {}) }, files: evidence.files, artifacts: evidence.artifacts });
        }
        throw error;
      } finally { await env?.cleanup(context); await prepared?.cleanup(); }
    };
    return candidate ? withFileWriteLock(workspaceFile(identity.cwd, `sandbox-candidates/${createHash("sha256").update(candidate.directory).digest("hex")}.json`), run) : run();
  } };
}
