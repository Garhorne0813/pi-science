import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TSchema } from "typebox";
import registerQuestionnaire from "../../pi/extensions/pi-science-ask-user-question-web.js";
import type { InteractionBridge } from "./interaction-bridge.js";

type LegacyQuestionnaireTool = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
};

/** Adapts the existing questionnaire validation and answer formatting to AgentHarness. */
export function questionnaireHarnessTool(bridge: InteractionBridge): AgentHarnessTool<{ env: NodeExecutionEnv }> {
  let tool: LegacyQuestionnaireTool | undefined;
  registerQuestionnaire({ registerTool: (registered: LegacyQuestionnaireTool) => { tool = registered; } });
  if (!tool) throw new Error("questionnaire tool registration failed");
  const legacy = tool;
  return {
    name: legacy.name,
    label: legacy.label,
    description: legacy.description,
    parameters: legacy.parameters,
    async execute(id, params, onUpdate, _toolContext, _invocation, context) {
      const result = await legacy.execute(id, params, context.abortSignal, onUpdate, {
        hasUI: true,
        mode: "web",
        ui: { input: (title: string, prefill: string) => bridge.request(title, prefill, context.abortSignal) },
      });
      return { ...result, details: result.details };
    },
  };
}
