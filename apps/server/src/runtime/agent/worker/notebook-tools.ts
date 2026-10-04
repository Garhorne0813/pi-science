import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import registerNotebookTools from "../../shared/extensions/pi-science-notebook.js";

type LegacyNotebookTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: { cwd: string; sessionId: string }) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
};

/** Reuse the existing notebook API implementation with the shared Notebook implementation. */
export function notebookHarnessTools(cwd: string, sessionId: string): AgentHarnessTool<{ env: NodeExecutionEnv }>[] {
  const registered: LegacyNotebookTool[] = [];
  registerNotebookTools({ registerTool: (tool: LegacyNotebookTool) => registered.push(tool) });
  return registered.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    async execute(toolCallId, params, onUpdate, _context, _invocation, context) {
      const result = await tool.execute(toolCallId, params, context.abortSignal, onUpdate, { cwd, sessionId });
      return { ...result, details: result.details };
    },
  }));
}
