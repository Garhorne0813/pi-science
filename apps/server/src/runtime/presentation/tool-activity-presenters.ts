import type { ToolPresentation } from "@pi-science/contracts";

const PLAN_TOOLS = new Set(["todo", "plan_update", "task_state", "internal_checkpoint"]);
const INTERACTION_TOOLS = new Set(["ask_user_question", "permission_request", "request_permission", "confirmation", "authenticate"]);

export function toolActivityPresentation(toolName: string, rawInput: unknown): ToolPresentation | undefined {
  const tool = toolName.trim().toLowerCase();
  const input = record(rawInput);
  const description = text(input.description);
  if (PLAN_TOOLS.has(tool)) return { version: 1, kind: "other", title: "Update task plan", importance: "micro", domain: "generic" };
  if (INTERACTION_TOOLS.has(tool)) return { version: 1, kind: "interaction", title: "Needs your input", importance: "interrupt", domain: "generic" };
  if (tool === "runtime_recovery" || tool === "reconnect") return { version: 1, kind: "system", title: "Resume the task", importance: "interrupt", domain: "generic" };
  const kind: ToolPresentation["kind"] | null = tool === "read" || tool === "read_file" || tool === "notebook_read" ? "read"
    : ["grep", "rg", "search", "search_files", "find", "ls", "list_files", "web_search", "tavily_search", "search_web"].includes(tool) ? "search"
      : ["web_fetch", "fetch"].includes(tool) ? "fetch"
        : ["edit", "write", "write_file", "apply_patch", "notebook_edit"].includes(tool) ? "edit"
          : ["notebook", "notebook_run", "run_cell", "execute_code"].includes(tool) ? "compute"
            : description ? (/(test|vitest|pytest|jest|typecheck|lint|build|check|verify|validate|测试|验证)/i.test(description) ? "verify" : /(analy|analysis|simulate|compute|forecast|model|分析|计算|模拟)/i.test(description) ? "compute" : "execute") : null;
  if (!kind) return undefined;
  const domain: ToolPresentation["domain"] = tool.includes("notebook") ? "science" : kind === "search" || kind === "fetch" && ["web_fetch", "fetch"].includes(tool) ? "research" : "code";
  const title = toolActivityTitle(toolName, rawInput) || description || toolName;
  return {
    version: 1,
    kind,
    title,
    ...(description ? { description } : {}),
    importance: kind === "read" || kind === "search" || kind === "fetch" ? "micro" : "stage",
    domain,
    narrativeHint: kind === "edit" ? { state: "implementation" } : kind === "verify" ? { state: "verify" } : kind === "compute" ? { state: "compute" } : undefined,
  };
}
export function toolActivityTitle(toolName: string, rawInput: unknown): string | undefined {
  const tool = toolName.trim().toLowerCase();
  if (!tool || PLAN_TOOLS.has(tool) || INTERACTION_TOOLS.has(tool)) return undefined;
  const input = record(rawInput);
  const description = text(input.description);
  if (tool === "read" || tool === "read_file") return `Reading ${shortPath(text(input.path) || text(input.file_path) || "file")}`;
  if (["grep", "search", "search_files", "rg"].includes(tool)) return `Searching for ${trim(text(input.pattern) || text(input.query) || "matching code")}`;
  if (["find", "ls", "list_files"].includes(tool)) return `Listing ${shortPath(text(input.path) || text(input.directory) || "workspace files")}`;
  if (["edit", "write", "write_file", "apply_patch"].includes(tool)) return `Updating ${shortPath(text(input.path) || text(input.file_path) || "file")}`;
  if (["web_search", "tavily_search", "search_web"].includes(tool)) return `Searching the web for ${trim(text(input.query) || "sources")}`;
  if (["bash", "python", "run_code", "execute"].includes(tool)) return description || undefined;
  return description || `Running ${toolName.replace(/[_-]+/g, " ").trim() || "tool"}`;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function shortPath(path: string): string { const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean); return trim(parts.at(-1) || path || "file"); }
function trim(value: string, max = 80): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
