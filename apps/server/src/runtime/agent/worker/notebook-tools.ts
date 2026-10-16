import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import registerNotebookTools from "../../shared/extensions/pi-science-notebook.js";
import { realpath, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { isWithin } from "../../sandbox/policy.js";
import { candidateKernelGrant, workerKernelGrant } from "../../sandbox/kernel-authorization.js";
import { sandboxCandidate, type SandboxIdentity } from "./sandbox-tool.js";

type LegacyNotebookTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: { cwd: string; sessionId: string; sandboxGrant?: string }) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
};

/** Reuse the existing notebook API implementation with the shared Notebook implementation. */
export function notebookHarnessTools(cwd: string, sessionId: string, identity?: SandboxIdentity): AgentHarnessTool<{ env: NodeExecutionEnv }>[] {
  const registered: LegacyNotebookTool[] = [];
  registerNotebookTools({ registerTool: (tool: LegacyNotebookTool) => registered.push(tool) });
  return registered.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(toolCallId, params, onUpdate, _context, invocation, context) {
      let sandboxGrant: string | undefined;
      if (identity?.candidateId || identity?.delegatedAgent === "auto-research/experimenter") {
        if (!identity.candidateId) throw new Error("Candidate notebook requires a bound candidate_id");
        const candidate = await sandboxCandidate(identity, invocation.operationId, identity.candidateId);
        const path = resolve(cwd, String((params as { path?: unknown })?.path ?? ""));
        if (tool.name === "notebook_edit" || !isWithin(candidate.work, path) && (tool.name !== "notebook_read" || !isWithin(candidate.input, path)) || await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Notebook path is outside the assigned candidate work/input");
        if (!(tool.name === "notebook_read" ? [candidate.input, candidate.work] : [candidate.work]).includes(dirname(path))) throw new Error("Candidate notebooks must be top-level input/work files");
        sandboxGrant = candidateKernelGrant(identity, invocation.operationId, process.env.PI_SCIENCE_INTERNAL_TOKEN);
      } else if (tool.name === "notebook_run" && process.env.PI_SCIENCE_INTERNAL_TOKEN) {
        sandboxGrant = workerKernelGrant(identity ?? { cwd, sessionId }, invocation.operationId, process.env.PI_SCIENCE_INTERNAL_TOKEN);
      }
      const result = await tool.execute(toolCallId, params, context.abortSignal, onUpdate, { cwd, sessionId, sandboxGrant });
      return { ...result, details: result.details };
    },
  }));
}
