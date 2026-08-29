/**
 * Typed, side-effect-free handoff tools for Node-managed research runtimes.
 * The extension never mutates durable state. Node consumes and validates the
 * result details after the runtime settles.
 */

const NODE_REF = {
  oneOf: [
    { type: "object", properties: { node_id: { type: "string" } }, required: ["node_id"], additionalProperties: false },
    { type: "object", properties: { action_id: { type: "string" } }, required: ["action_id"], additionalProperties: false },
  ],
};

const EXPERIMENT_SPEC = {
  type: "object",
  properties: {
    objective: { type: "string" },
    expected_metrics: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    estimated_cost: { type: "object", additionalProperties: { type: "number" } },
    materialization: { type: "string", enum: ["pi_candidate"] },
  },
  required: ["objective"],
  additionalProperties: false,
};

const ACTION = {
  oneOf: [
    action("question.add", { question: { type: "string" } }, ["question"]),
    action("hypothesis.add", { statement: { type: "string" }, assumptions: stringArray(), parent_refs: { type: "array", items: NODE_REF } }, ["statement"]),
    action("experiment.propose", { hypothesis_ref: NODE_REF, spec: EXPERIMENT_SPEC, priority: { type: "number" } }, ["hypothesis_ref", "spec"]),
    action("literature.request", { question: { type: "string" }, parent_refs: { type: "array", items: NODE_REF }, priority: { type: "number" } }, ["question"]),
    action("node.prioritize", { node_id: { type: "string" }, priority: { type: "number" } }, ["node_id", "priority"]),
    action("branch.close", { node_id: { type: "string" }, reason: { type: "string" } }, ["node_id", "reason"]),
    action("verification.request", { target_node_id: { type: "string" }, priority: { type: "number" } }, ["target_node_id"]),
    action("synthesis.request", { target_node_ids: stringArray(), priority: { type: "number" } }, []),
    action("user_input.request", { reason: { type: "string" }, options: stringArray() }, ["reason"]),
    action("claim.propose", { statement: { type: "string" }, scope: { type: ["string", "null"] }, confidence: { type: "number" } }, ["statement"]),
    action("research.stop_recommended", { reason: { type: "string" } }, ["reason"]),
  ],
};

function stringArray() { return { type: "array", items: { type: "string" } }; }
function action(type: string, properties: Record<string, unknown>, required: string[]) {
  return {
    type: "object",
    properties: { action_id: { type: "string" }, type: { type: "string", enum: [type] }, ...properties },
    required: ["action_id", "type", ...required],
    additionalProperties: false,
  };
}

function terminal(text: string, details: unknown) {
  return { content: [{ type: "text", text }], details, terminate: true };
}

export default function registerPiScienceResearch(pi: any) {
  pi.registerTool({
    name: "research_commit",
    label: "Research Commit",
    description: "Submit one final typed action batch for the current Research Graph decision epoch.",
    promptSnippet: "End a research supervisor epoch by calling research_commit exactly once",
    promptGuidelines: ["Never print the commit as JSON text; call this tool as the final action.", "Use action_id references for nodes created earlier in the same commit."],
    parameters: {
      type: "object",
      properties: {
        research_id: { type: "string" },
        base_revision: { type: "number" },
        rationale: { type: "string" },
        actions: { type: "array", minItems: 1, maxItems: 100, items: ACTION },
      },
      required: ["research_id", "base_revision", "actions"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) { return terminal("Research decision captured.", params); },
  });

  pi.registerTool({
    name: "research_materialize",
    label: "Materialize Experiment",
    description: "Return the final executable candidate for one approved experiment specification.",
    promptSnippet: "End an experiment materialization operation with research_materialize",
    promptGuidelines: ["Return self-contained text files only.", "The entrypoint must write result.json beneath PI_SCIENCE_OUTPUT_DIR."],
    parameters: {
      type: "object",
      properties: {
        research_id: { type: "string" },
        node_id: { type: "string" },
        approach_summary: { type: "string" },
        rationale: { type: "string" },
        files: { type: "object", minProperties: 1, maxProperties: 100, additionalProperties: { type: "string" } },
        entrypoint: { type: "string" },
        expected_artifacts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, kind: { type: "string" } }, required: ["path"], additionalProperties: false } },
      },
      required: ["research_id", "node_id", "approach_summary", "files", "entrypoint"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) { return terminal("Experiment candidate captured.", params); },
  });

  pi.registerTool({
    name: "research_worker_result",
    label: "Research Worker Result",
    description: "Return findings from one durable literature, analysis, verification, or synthesis operation.",
    promptSnippet: "End a durable research worker operation with research_worker_result",
    parameters: {
      type: "object",
      properties: {
        research_id: { type: "string" },
        node_id: { type: "string" },
        kind: { type: "string", enum: ["literature", "analysis", "verification", "synthesis"] },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "object", additionalProperties: true } },
        claims: { type: "array", items: { type: "object", properties: { statement: { type: "string" }, confidence: { type: "number" }, scope: { type: ["string", "null"] } }, required: ["statement"], additionalProperties: false } },
        verdict: { type: "string", enum: ["verified", "failed"] },
      },
      required: ["research_id", "node_id", "kind", "summary"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) { return terminal("Research worker result captured.", params); },
  });
}
