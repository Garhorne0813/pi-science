import { z } from "zod";
import { researchTaskTypeSchema, type ResearchTaskType } from "@pi-science/contracts";

const intentSchema = z.object({
  mode: researchTaskTypeSchema,
  objective: z.string().trim().min(1).max(4000),
});

export type ResearchIntent = ReturnType<typeof compileResearchIntent>;

const iterativeModes = new Set<ResearchTaskType>(["research_loop", "optimize"]);

const iterativeInstructions: Record<"research_loop" | "optimize", string[]> = {
  research_loop: [
    "Inspect the conversation and workspace evidence before choosing the first hypothesis.",
    "Run one bounded experiment at a time, preserve artifacts, and critique the result before the next round.",
    "Stop when the evidence converges, the remaining uncertainty cannot be reduced with available inputs, or the iteration budget is exhausted.",
  ],
  optimize: [
    "Establish a reproducible baseline from the current workspace.",
    "Change one justified factor per round and measure it against the baseline while preserving hard constraints.",
    "Keep only verified improvements and stop after three rounds without progress or when the iteration budget is exhausted.",
  ],
};

const iterativeInstructionsZh: Record<"research_loop" | "optimize", string[]> = {
  research_loop: [
    "先检查当前对话和工作区证据，再选择第一个可验证假设。",
    "每轮只执行一个有边界的实验，保留产物，并在下一轮前批判性分析结果。",
    "当证据收敛、现有输入无法继续降低不确定性或达到轮次上限时自动停止。",
  ],
  optimize: [
    "根据当前工作区建立可复现的基线。",
    "每轮只改变一个有依据的因素，与基线比较，并保持硬性约束不退化。",
    "只保留经过验证的改进；连续三轮没有进展或达到轮次上限时自动停止。",
  ],
};

const workflowInstructions: Record<Exclude<ResearchTaskType, "research_loop" | "optimize">, string[]> = {
  compare: [
    "Identify the alternatives and make the comparison criteria explicit before judging them.",
    "Use workspace evidence or execute comparable checks when possible; clearly label assumptions.",
    "Return a comparison table, trade-offs, and a recommendation tied to the stated objective.",
  ],
  evaluate: [
    "Identify the exact result, run, file, or artifact being evaluated; ask for it if it is missing.",
    "Define acceptance criteria and distinguish deterministic checks from qualitative judgment.",
    "Report evidence, failed checks, uncertainty, and the next corrective action.",
  ],
  reproduce: [
    "Identify the source experiment or run and reconstruct its inputs, parameters, environment, and expected outputs.",
    "Run the reproduction in a separate workspace-contained output location without overwriting the source.",
    "Compare outputs with explicit tolerances and document every material deviation.",
  ],
};

export function compileResearchIntent(input: unknown) {
  const { mode, objective } = intentSchema.parse(input);
  const iterative = iterativeModes.has(mode);
  const inferredMetric = iterative ? inferMetric(objective) : null;
  const metric = inferredMetric ?? (mode === "research_loop"
    ? { name: "evidence_quality", direction: "maximize" as const }
    : mode === "optimize" ? { name: "objective_progress", direction: "maximize" as const } : null);
  const direction = metric?.direction ?? "maximize";
  const instructions = iterative
    ? (hasHan(objective) ? iterativeInstructionsZh : iterativeInstructions)[mode as keyof typeof iterativeInstructions]
    : workflowInstructions[mode as keyof typeof workflowInstructions];

  return {
    requires_confirmation: iterative,
    missing_fields: [],
    draft: {
      task_type: mode,
      execution_kind: iterative ? "iterative" as const : "conversation" as const,
      title: objective.slice(0, 200),
      objective,
      metric: metric?.name ?? null,
      direction,
      success_criterion: iterative ? successCriterion(mode, objective, inferredMetric) : null,
      plan_steps: instructions,
      budget: { max_candidates: mode === "optimize" ? 10 : 6, max_wall_seconds: 7200, max_parallel: 1 },
      stop_conditions: { target_metrics: {}, patience: 3, min_improvement: 0 },
      instructions,
      conversation_prompt: iterative ? null : formatConversationPrompt(mode, objective, instructions),
    },
  };
}

function inferMetric(objective: string): { name: string; direction: "maximize" | "minimize" } | null {
  const lower = objective.toLowerCase();
  const patterns: Array<[RegExp, string, "maximize" | "minimize"]> = [
    [/\baccuracy\b|准确率|精确率/, "accuracy", "maximize"],
    [/\bthroughput\b|吞吐量/, "throughput", "maximize"],
    [/\bspeed\b|速度/, "speed", "maximize"],
    [/\blatency\b|延迟/, "latency", "minimize"],
    [/\bruntime\b|运行时间|耗时/, "runtime", "minimize"],
    [/\bcost\b|成本|费用/, "cost", "minimize"],
    [/\bloss\b|损失/, "loss", "minimize"],
    [/\berror rate\b|错误率/, "error_rate", "minimize"],
    [/\byield\b|产率|收率/, "yield", "maximize"],
    [/\bf1(?: score)?\b|F1(?:分数)?/i, "f1_score", "maximize"],
    [/\bauc\b/i, "auc", "maximize"],
    [/\bmemory(?: usage)?\b|内存(?:占用)?/, "memory_usage", "minimize"],
    [/\btime to first token\b|\bttft\b|首\s*.?\s*token\s*时间|首字延迟/i, "time_to_first_token", "minimize"],
  ];
  for (const [pattern, name, direction] of patterns) if (pattern.test(lower)) return { name, direction };
  const english = lower.match(/\b(minimi[sz]e|reduce|lower|decrease|shorten|maximi[sz]e|increase|raise|improve)\s+(?:the\s+)?([a-z][a-z0-9 _-]{1,48})/i);
  if (english) return { name: metricName(english[2]!), direction: /minimi|reduce|lower|decrease|shorten/i.test(english[1]!) ? "minimize" : "maximize" };
  const chinese = objective.match(/(降低|减少|缩短|最小化|提高|提升|增加|最大化|改善)([^，。；,\n]{1,24})/);
  if (chinese) return { name: metricName(chinese[2]!), direction: /降低|减少|缩短|最小化/.test(chinese[1]!) ? "minimize" : "maximize" };
  return null;
}

function metricName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 64);
  return normalized || "objective_progress";
}

function successCriterion(mode: ResearchTaskType, objective: string, metric: { name: string; direction: "maximize" | "minimize" } | null): string {
  if (hasHan(objective)) {
    if (metric) return `用可复现测量${metric.direction === "minimize" ? "降低" : "提升"}“${metric.name.replaceAll("_", " ")}”，同时保证必要检查不退化。`;
    if (mode === "optimize") return `系统自动建立基线，验证“${objective}”是否取得可复现进展，同时保证必要检查不退化。`;
    return "持续提高证据的可复现性，排除不受支持的假设；当新增轮次无法实质增强结论时自动停止。";
  }
  if (metric) return `${metric.direction === "minimize" ? "Reduce" : "Improve"} ${metric.name.replaceAll("_", " ")} with reproducible measurements while preserving required checks.`;
  if (mode === "optimize") return `Demonstrate reproducible progress toward “${objective}” against an automatically established baseline, without regressing required checks.`;
  return "Increase reproducible evidence quality, eliminate unsupported hypotheses, and stop when additional rounds no longer materially strengthen the conclusion.";
}

function hasHan(value: string): boolean { return /\p{Script=Han}/u.test(value); }

function formatConversationPrompt(mode: ResearchTaskType, objective: string, instructions: string[]): string {
  const label = mode.replaceAll("_", " ");
  return [`[Workflow: ${label}]`, `Objective: ${objective}`, "", "Required process:", ...instructions.map((item, index) => `${index + 1}. ${item}`)].join("\n");
}
