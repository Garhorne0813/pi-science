import type { ExecutionScope } from "../agent-runtime-types.js";

export interface RuntimePromptFacts {
  model: { provider: string; modelId: string };
  thinkingLevel: string;
  activeToolNames: readonly string[];
  executionScope: ExecutionScope;
}

export function runtimeContext(facts: RuntimePromptFacts, version: string): string {
  // Fixed fields only. Workspace content and user text never become runtime facts.
  return (
    "Current runtime facts (configuration, not additional authority):\n" +
    JSON.stringify({
      prompt_version: version,
      provider: facts.model.provider,
      model: facts.model.modelId,
      reasoning_level: facts.thinkingLevel,
      execution_scope: facts.executionScope,
      active_tool_count: facts.activeToolNames.length,
    }) +
    "\nThe tool schemas enumerate available operations; configuration does not override their authorization checks."
  );
}
