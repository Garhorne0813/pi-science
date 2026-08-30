import type { ToolCallBlock } from "../../types/thread";
import { activityPolicy } from "./activity-policy";

export type NarrativeState = "orient" | "explore" | "research" | "analyze" | "implementation" | "compute" | "verify" | "interaction" | "recover" | "error" | "complete";
export type NarrativeDomain = "code" | "research" | "science" | "document" | "data" | "generic";
export type OperationKind = "read" | "search" | "fetch" | "edit" | "execute" | "compute" | "verify" | "interaction" | "recover" | "other";

export interface ToolActivityPresentation {
  kind: OperationKind;
  title: string;
  description?: string;
  importance: "micro" | "stage" | "interrupt";
  domain: NarrativeDomain;
  finalVerification?: boolean;
  narrativeHint?: Extract<NarrativeState, "explore" | "research" | "analyze" | "implementation" | "compute" | "verify">;
}

export interface PresentedActivity {
  state: NarrativeState;
  domain: NarrativeDomain;
  mergeKey: string;
  source: ToolCallBlock;
  forced: boolean;
}

const READ_TOOLS = new Set(["read", "read_file", "grep", "rg", "search", "search_files", "find", "ls", "list_files"]);
const RESEARCH_TOOLS = new Set(["web_search", "search_web", "tavily_search", "web_fetch", "fetch"]);
const EDIT_TOOLS = new Set(["edit", "write", "write_file", "apply_patch"]);
const VERIFY_TOOLS = new Set(["test", "vitest", "pytest", "jest", "typecheck", "lint", "build", "compile", "check"]);
const OPAQUE_TOOLS = new Set(["bash", "python", "run_code", "execute"]);
const NOTEBOOK_READ_TOOLS = new Set(["notebook_read"]);
const NOTEBOOK_EDIT_TOOLS = new Set(["notebook_edit"]);
const NOTEBOOK_RUN_TOOLS = new Set(["notebook", "notebook_run", "run_cell", "execute_code"]);
const FINAL_VERIFY_FIELDS = ["finalVerification", "final_verification"] as const;

/** Fold precise tool events into one quiet, task-level progress narrative. */
export function selectNarrativeActivity(blocks: ToolCallBlock[]): PresentedActivity | null {
  const entries = blocks.map((block) => ({ block, presentation: toolActivityPresentation(block) })).filter((entry): entry is { block: ToolCallBlock; presentation: ToolActivityPresentation } => entry.presentation !== null);
  const implementationBusy = entries.some(({ block, presentation }) => block.status === "running" && (presentation.kind === "edit" || presentation.kind === "verify"));
  let current: PresentedActivity | null = null;
  let interrupted: PresentedActivity | null = null;
  let implementationSeen = false;
  let supportBurst = 0;
  let supportBurstStartedAt: number | null = null;

  for (const { block, presentation } of entries) {
    const next = narrativeFor(block, presentation, implementationSeen);
    if (!next) continue;

    if (next.state === "interaction" || next.state === "error" || next.state === "recover") {
      if (current && current.state !== "interaction" && current.state !== "error" && current.state !== "recover") interrupted = current;
      current = next;
      supportBurst = 0;
      supportBurstStartedAt = null;
      continue;
    }
    if (current && (current.state === "interaction" || current.state === "error" || current.state === "recover") && interrupted) current = interrupted;

    if (next.state === "implementation") {
      implementationSeen = true;
      supportBurst = 0;
      supportBurstStartedAt = null;
      current = next;
      continue;
    }

    if (current?.state === "implementation" && presentation.importance === "micro") {
      supportBurst += 1;
      const eventTime = activityTime(block);
      supportBurstStartedAt ??= eventTime;
      const burstDuration = eventTime !== null && supportBurstStartedAt !== null ? eventTime - supportBurstStartedAt : 0;
      if (supportBurst < 3 || burstDuration < 1_500 || implementationBusy) continue;
    } else {
      supportBurst = 0;
      supportBurstStartedAt = null;
    }
    if (current?.state === "research" && presentation.importance === "micro" && next.state === "explore") continue;

    current = next;
  }
  return current;
}

/** Frontend fallback until tool-owned presentation metadata reaches the wire. */
export function toolActivityPresentation(block: ToolCallBlock): ToolActivityPresentation | null {
  const plane = activityPolicy(block).plane;
  if (plane === "plan-control") return null;
  if (block.presentation) return fromToolPresentation(block.presentation);
  const tool = block.tool.trim().toLowerCase();
  if (plane === "interaction") {
    if (block.status !== "waiting-approval" && block.status !== "running") return null;
    return presentation("interaction", block, "interrupt", "generic");
  }
  if (block.status === "error") return presentation("other", block, "interrupt", domainFor(tool));
  if (plane === "system") {
    if (tool === "runtime_recovery" || tool === "reconnect") return presentation("recover", block, "interrupt", "generic");
    return null;
  }
  if (NOTEBOOK_READ_TOOLS.has(tool)) return presentation("read", block, "micro", "science");
  if (NOTEBOOK_EDIT_TOOLS.has(tool)) return presentation("edit", block, "stage", "science");
  if (NOTEBOOK_RUN_TOOLS.has(tool)) return presentation("compute", block, "stage", "science");
  if (READ_TOOLS.has(tool)) return presentation(tool.includes("search") || tool === "grep" || tool === "rg" ? "search" : "read", block, "micro", "code");
  if (RESEARCH_TOOLS.has(tool)) return presentation(tool.includes("fetch") ? "fetch" : "search", block, "micro", "research");
  if (EDIT_TOOLS.has(tool)) return presentation("edit", block, "stage", domainFor(tool));
  if (VERIFY_TOOLS.has(tool)) return presentation("verify", block, "stage", "code");
  if (!OPAQUE_TOOLS.has(tool)) return null;

  const description = stringField(block.input?.description);
  if (!description) return null;
  const kind = kindFromDescription(description);
  return kind ? presentation(kind, block, "stage", kind === "compute" ? "science" : kind === "verify" || kind === "edit" ? "code" : "generic", description) : null;
}

function fromToolPresentation(presentation: ToolCallBlock["presentation"]): ToolActivityPresentation | null {
  if (!presentation) return null;
  if (presentation.kind === "artifact" || presentation.kind === "other") return null;
  if (presentation.kind === "system") return { kind: "recover", title: presentation.title, importance: presentation.importance, domain: presentation.domain };
  return {
    kind: presentation.kind,
    title: presentation.title,
    ...(presentation.description ? { description: presentation.description } : {}),
    importance: presentation.importance,
    domain: presentation.domain,
    ...(presentation.narrativeHint?.state ? { narrativeHint: presentation.narrativeHint.state } : {}),
    ...(presentation.narrativeHint?.finalVerification !== undefined ? { finalVerification: presentation.narrativeHint.finalVerification } : {}),
  };
}

function narrativeFor(block: ToolCallBlock, presentation: ToolActivityPresentation, implementationSeen: boolean): PresentedActivity | null {
  if (block.status === "error") return activity("error", presentation.domain, block, true);
  if (presentation.kind === "interaction") return activity("interaction", presentation.domain, block, true);
  if (presentation.kind === "recover") return activity("recover", presentation.domain, block, true);
  if (presentation.narrativeHint) {
    if (presentation.narrativeHint === "verify" && implementationSeen && !presentation.finalVerification) return activity("implementation", presentation.domain, block);
    return activity(presentation.narrativeHint, presentation.domain, block);
  }
  if (presentation.kind === "edit") return activity("implementation", presentation.domain, block);
  if (presentation.kind === "compute") return activity(implementationSeen && presentation.domain === "science" ? "implementation" : "compute", presentation.domain, block);
  if (presentation.kind === "verify") {
    const finalVerification = presentation.finalVerification === true || FINAL_VERIFY_FIELDS.some((field) => block.input?.[field] === true);
    return activity(implementationSeen && !finalVerification ? "implementation" : "verify", presentation.domain, block);
  }
  if (presentation.kind === "search" || presentation.kind === "fetch") {
    return activity(presentation.domain === "research" ? "research" : "explore", presentation.domain, block);
  }
  if (presentation.kind === "read") return activity("explore", presentation.domain, block);
  if (presentation.kind === "execute") return activity("analyze", presentation.domain, block);
  return null;
}

function kindFromDescription(description: string): OperationKind | null {
  const text = description.toLowerCase();
  if (/\b(tests?|vitest|pytest|jest|typecheck|lint|build|compile|check|verify|validate)\b|测试|验证|类型检查|构建/.test(text)) return "verify";
  if (/\b(analy[sz]e?|analysis)\b|分析/.test(text)) return "execute";
  if (/\b(simulat|compute|forecast|regression|model)\b|计算|模拟|预测/.test(text)) return "compute";
  if (/\b(update|edit|write|patch|generate|create)\b|更新|修改|生成|创建|写入/.test(text)) return "edit";
  return null;
}

function presentation(kind: OperationKind, block: ToolCallBlock, importance: ToolActivityPresentation["importance"], domain: NarrativeDomain, description = stringField(block.input?.description)): ToolActivityPresentation {
  return { kind, title: block.title?.trim() || block.tool, ...(description ? { description } : {}), importance, domain };
}

function activity(state: NarrativeState, domain: NarrativeDomain, source: ToolCallBlock, forced = false): PresentedActivity {
  return { state, domain, source, forced, mergeKey: `${state}:${domain}` };
}

function domainFor(tool: string): NarrativeDomain {
  if (tool.includes("notebook")) return "science";
  if (tool.includes("document") || tool.includes("artifact")) return "document";
  return "code";
}

function activityTime(block: ToolCallBlock): number | null {
  const value = block.startedAt ?? block.endedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringField(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
