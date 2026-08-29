const PLAN_TOOLS = new Set(["todo", "plan_update", "task_state", "internal_checkpoint"]);
const INTERACTION_TOOLS = new Set(["ask_user_question", "permission_request", "request_permission", "confirmation", "authenticate"]);

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
