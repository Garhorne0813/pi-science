import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { isVisibleActivity } from "./activity-policy";
import { toolActivityPresentation } from "./activity-narrative";
import { extractTodoSnapshot } from "./todos";

export interface ActivityTask {
  /** Purpose supplied by the model/tool/plan, never inferred from a filename. */
  text: string | null;
  fallback: string;
  responding: boolean;
  sourceId?: string;
}

/** Unlike the debounced phase, the task is projected from the latest events
 * on every update. A second read can share a phase but have a new purpose. */
export function selectActivityTask(blocks: ThreadBlock[]): ActivityTask {
  const tools = blocks.filter((block): block is ToolCallBlock => block.kind === "tool" && isVisibleActivity(block));
  const running = tools.findLast((block) => block.status === "running" || block.status === "waiting-approval");
  const current = running ?? tools.at(-1);
  const currentIndex = current ? blocks.indexOf(current) : blocks.length;
  const agent = blocks.findLast((block) => block.kind === "agent" && block.parts.some((part) => part.text.trim()));
  const responding = !running && agent?.kind === "agent" && agent.presentationRole !== "intermediate" && (!current || blocks.indexOf(agent) > currentIndex);
  if (responding) return { text: null, fallback: "respond", responding: true };

  const semantics = current ? toolActivityPresentation(current) : null;
  const fallback = semantics?.kind ?? "orient";
  const explicit = purpose(current?.presentation?.description) || purpose(current?.input?.description)
    || purpose(current?.presentation?.title) || purpose(current?.title);
  if (explicit) return { text: explicit, fallback, responding: false };

  const narration = blocks.findLast((block) => block.kind === "agent" && block.presentationRole !== "final" && block.parts.some((part) => part.text.trim()));
  const plan = extractTodoSnapshot(blocks)?.tasks.find((task) => task.status === "in_progress");
  const planIndex = blocks.findLastIndex((block) => block.kind === "tool" && block.tool === "todo");
  const planText = purpose(plan?.activeForm) || purpose(plan?.subject);
  if (planText && (!narration || planIndex > blocks.indexOf(narration))) return { text: planText, fallback, responding: false };
  const prose = narration?.kind === "agent" ? narration.parts.map((part) => part.text).join("").trim() : "";
  const narrationText = purpose(prose);
  // Longer progress reports must remain available in full in the process body.
  const subtitleContainsReport = prose.length <= 160 && !prose.includes("\n");
  return { text: narrationText || planText, fallback, responding: false, ...(narrationText && narration && subtitleContainsReport ? { sourceId: narration.id } : {}) };
}

function purpose(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#]/g, "")
    .trim().split(/\n+/).find((line) => line.trim())?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  // These are mechanical tool labels. Keep them in Execution details rather
  // than promoting them to a description of the user's task.
  if (/^(?:reading|read|listing|updating|writing|running)\s+(?:\S*[./\\]\S+|file|files|directory|workspace|bash|python)\s*$/i.test(text)
    || /^(?:正在)?(?:读取|列出|写入|更新)\s*(?:\S*[./\\]\S+|文件|目录|file)\s*$/.test(text)
    || /^(?:read|bash|python|grep|rg|ls|edit|write|file)$/i.test(text)) return null;
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
