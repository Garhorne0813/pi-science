import type { ToolCallBlock } from "../../types/thread";

export type ActivityTranslator = (key: string, values?: Record<string, unknown>) => string;

const DEFAULT_LABELS: Record<string, string> = {
  "conversation.activity.read": "Reading {{target}}", "conversation.activity.search": "Searching for {{target}}", "conversation.activity.list": "Listing {{target}}", "conversation.activity.write": "Updating {{target}}", "conversation.activity.run": "Running {{target}}", "conversation.activity.webSearch": "Searching the web for {{target}}", "conversation.activity.tool": "Running {{tool}}",
};

export function presentToolActivity(block: ToolCallBlock, translate: ActivityTranslator = defaultTranslate): string {
  if (block.presentation?.title?.trim()) return block.presentation.title.trim();
  if (block.title?.trim()) return block.title.trim();
  const input = block.input ?? {};
  const tool = block.tool.trim().toLowerCase();
  const description = text(input.description);
  if (tool === "read" || tool === "read_file") return translate("conversation.activity.read", { target: shortPath(text(input.path) || text(input.file_path) || "file") });
  if (["grep", "search", "search_files", "rg"].includes(tool)) return translate("conversation.activity.search", { target: trim(text(input.pattern) || text(input.query) || "matching code") });
  if (["find", "ls", "list_files"].includes(tool)) return translate("conversation.activity.list", { target: shortPath(text(input.path) || text(input.directory) || "workspace files") });
  if (["edit", "write", "write_file", "apply_patch"].includes(tool)) return translate("conversation.activity.write", { target: shortPath(text(input.path) || text(input.file_path) || "file") });
  if (["web_search", "tavily_search", "search_web"].includes(tool)) return translate("conversation.activity.webSearch", { target: trim(text(input.query) || "sources") });
  if (["bash", "python", "run_code", "execute"].includes(tool)) return description || translate("conversation.activity.run", { target: tool });
  return description || translate("conversation.activity.tool", { tool: block.tool.replace(/[_-]+/g, " ").trim() || "tool" });
}

function defaultTranslate(key: string, values: Record<string, unknown> = {}): string { return (DEFAULT_LABELS[key] ?? key).replace(/{{(\w+)}}/g, (_match, name: string) => String(values[name] ?? "")); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function shortPath(path: string): string { const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean); return trim(parts.at(-1) || path || "file"); }
function trim(value: string, max = 80): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
