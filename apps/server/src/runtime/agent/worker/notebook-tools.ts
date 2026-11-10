import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import { withTaskDescription } from "./task-description.js";
import registerNotebookTools from "../../shared/extensions/pi-science-notebook.js";
import { realpath, lstat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { isWithin } from "../../sandbox/policy.js";
import { confinedKernelGrant, workerKernelGrant } from "../../sandbox/kernel-authorization.js";
import { executionGrantPolicy } from "../../sandbox/execution-grants.js";
import { type SandboxIdentity } from "./confined-read-tool.js";

type LegacyNotebookTool = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TSchema;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: { cwd: string; sessionId: string; sandboxGrant?: string },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
};

/** Reuse the existing notebook API implementation with the shared Notebook implementation. */
export function notebookHarnessTools(
  cwd: string,
  sessionId: string,
  identity?: SandboxIdentity,
): AgentHarnessTool<{ env: NodeExecutionEnv }>[] {
  const registered: LegacyNotebookTool[] = [];
  registerNotebookTools({ registerTool: (tool: LegacyNotebookTool) => registered.push(tool) });
  return registered.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])]
      .filter(Boolean)
      .join("\n"),
    parameters:
      tool.name === "notebook_run" ? withTaskDescription(tool.parameters) : tool.parameters,
    async execute(toolCallId, params, onUpdate, _context, invocation, context) {
      let sandboxGrant: string | undefined;
      if (
        identity?.executionGrantId ||
        identity?.candidateId ||
        identity?.executionScope === "candidate" ||
        identity?.executionScope === "confined"
      ) {
        if (!identity.executionGrantId)
          throw new Error(
            "Candidate notebook requires a bound candidate_id and server-bound execution grant",
          );
        const policy = await executionGrantPolicy(identity, undefined, tool.name);
        const path = resolve(cwd, String((params as { path?: unknown })?.path ?? ""));
        if (
          tool.name === "notebook_edit" ||
          !(tool.name === "notebook_read" ? policy.readPaths : policy.writePaths).some((root) =>
            isWithin(root, path),
          ) ||
          (await realpath(path)) !== path ||
          !(await lstat(path)).isFile()
        )
          throw new Error("Notebook path is outside the assigned candidate work/input");
        if (
          !(tool.name === "notebook_read" ? policy.readPaths : policy.writePaths).includes(
            dirname(path),
          )
        )
          throw new Error("Candidate notebooks must be top-level input/work files");
        sandboxGrant = await confinedKernelGrant(
          identity,
          invocation.operationId,
          process.env.PI_SCIENCE_INTERNAL_TOKEN,
        );
      } else if (tool.name === "notebook_run" && process.env.PI_SCIENCE_INTERNAL_TOKEN) {
        sandboxGrant = await workerKernelGrant(
          identity ?? { cwd, sessionId },
          invocation.operationId,
          process.env.PI_SCIENCE_INTERNAL_TOKEN,
        );
      }
      const result = await tool.execute(toolCallId, params, context.abortSignal, onUpdate, {
        cwd,
        sessionId,
        sandboxGrant,
      });
      return { ...result, details: result.details };
    },
  }));
}
