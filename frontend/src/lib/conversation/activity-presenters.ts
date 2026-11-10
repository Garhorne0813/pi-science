import { activityCategory, activityFileLabel, activityProgramName, activityPurposeText, activityQueryText, activityReadTarget, activityUrlLabel, isMcpToolName, scrubActivityText, type ActivityCategory } from "@pi-science/contracts";
import type { ToolCallBlock } from "../../types/thread";

export type ActivityTranslator = (key: string, values?: Record<string, unknown>) => string;

const DEFAULT_LABELS: Record<string, string> = {
  "conversation.activity.terminal": "Terminal", "conversation.activity.fetch": "Fetching {{target}}", "conversation.activity.read": "Reading {{target}}", "conversation.activity.search": "Searching for {{target}}", "conversation.activity.list": "Listing {{target}}", "conversation.activity.write": "Updating {{target}}", "conversation.activity.run": "Running {{target}}", "conversation.activity.webSearch": "Searching the web for {{target}}", "conversation.activity.tool": "Running {{tool}}",
  "conversation.activity.memory.search": "Search memory",
  "conversation.activity.memory.read": "Read memory",
  "conversation.activity.memory.write": "Update memory",
  "conversation.activity.citation.verify": "Verify citations",
  "conversation.activity.citation.read": "Read source evidence",
  "conversation.activity.citation.record": "Record evidence citations",
  "conversation.activity.delegate": "Delegate task",
  "conversation.activity.delegate.list": "List subagents",
  "conversation.activity.delegate.status": "Check subagent status",
  "conversation.activity.delegate.collect": "Collect subagent results",
  "conversation.activity.delegate.stop": "Stop subagent",
  "conversation.activity.delegate.manage": "Manage subagents",
};

const READ_TOOLS = new Set(["read", "read_file", "notebook_read", "view_image"]);
const SEARCH_TOOLS = new Set(["grep", "rg", "search", "search_files", "find", "glob"]);
const LIST_TOOLS = new Set(["ls", "list", "list_files"]);
const WRITE_TOOLS = new Set(["edit", "write", "write_file", "apply_patch", "patch", "notebook_edit", "delete", "delete_file", "move", "rename"]);
const WEB_SEARCH_TOOLS = new Set(["web_search", "tavily_search", "search_web"]);
const FETCH_TOOLS = new Set(["web_fetch", "fetch", "fetch_url", "read_url"]);
/** Commands this row may describe by program name. Kernel tools are included
 *  because their input is code, not prose. */
const SHELL_TOOLS = new Set(["bash", "shell", "terminal", "execute", "run_code", "python", "r", "rscript", "notebook_run", "run_cell", "execute_code", "jupyter"]);
const PATH_KEYS = ["path", "file_path", "directory"] as const;
const TARGET_KEYS = ["query", "q", "pattern", "search_query", "doi", "pmcid", "accession", "identifier", "gene", "name"] as const;

/** Tool names are matched exactly; MCP names never enter built-in inference. */
export function activityToolName(tool: string): string {
  return tool.trim().toLowerCase();
}

export function isMcpTool(tool: string): boolean {
  return isMcpToolName(tool);
}

function mcpActivityLabel(tool: string): string {
  const [server, ...name] = tool.trim().slice(5).split("__");
  return server && name.length ? `${server} · ${name.join("__")}` : tool.trim();
}

/** A purpose the model wrote for the row, cleaned of anything that reads as a
 *  credential. `undefined` when there is none or when it only repeats the
 *  tool's own name. */
export function activityTaskTitle(block: ToolCallBlock): string | undefined {
  return activityDescription(block) ?? meaningfulActivityTitle(block.presentation?.title, block.tool) ?? meaningfulActivityTitle(block.title, block.tool);
}

/** The purpose the model wrote for the row, cleaned of anything that reads as a
 *  credential. A purpose that repeats the command is dropped: it is a second
 *  copy of the arguments, which the row never shows. */
function activityDescription(block: ToolCallBlock): string | undefined {
  const description = text(block.presentation?.description) || text(block.input?.description);
  if (!description) return undefined;
  const command = text(block.input?.command);
  if (command && description.includes(command)) return undefined;
  return activityPurposeText(description);
}

/** The subject of a call, formatted for its own kind. Shell redaction rules do
 *  not run here: a query is prose, and `token binding kinase` is not a token. */
export function activityTarget(block: ToolCallBlock): string {
  if (isMcpTool(block.tool)) return "";
  const input = block.input ?? {};
  // A query names what was searched for; a scope path only bounds it. Prefer
  // the query so `grep {pattern, path}` does not collapse to a basename.
  for (const key of TARGET_KEYS) {
    const value = text(input[key]);
    if (value) return activityQueryText(value);
  }
  for (const key of PATH_KEYS) {
    const value = text(input[key]);
    if (value) return activityFileLabel(value);
  }
  const url = text(input.url);
  if (url) return activityUrlLabel(url);
  return "";
}

export function presentToolActivity(block: ToolCallBlock, translate: ActivityTranslator = defaultTranslate): string {
  const tool = activityToolName(block.tool);
  if (isMcpToolName(tool)) return mcpActivityLabel(block.tool);
  const input = block.input ?? {};
  const target = activityTarget(block);
  const append = (label: string, value: string = target) => value ? `${label} · ${value}` : label;

  // An operation with a structural name shows what it touched. The purpose the
  // model wrote stays on the phase row, so it cannot replace the read slice or
  // the file a write names.
  if (READ_TOOLS.has(tool)) return translate("conversation.activity.read", { target: activityReadTarget(input) });
  if (SEARCH_TOOLS.has(tool)) return translate("conversation.activity.search", { target: target || "matching files" });
  if (LIST_TOOLS.has(tool)) return translate("conversation.activity.list", { target: target || "workspace files" });
  if (WRITE_TOOLS.has(tool)) return translate("conversation.activity.write", { target: target || "file" });
  if (WEB_SEARCH_TOOLS.has(tool)) return translate("conversation.activity.webSearch", { target: target || "sources" });
  if (FETCH_TOOLS.has(tool)) return translate("conversation.activity.fetch", { target: target || "web page" });

  // A shell row names, in order: the purpose the model wrote, a stored
  // `Running …` title, then the program it starts. Arguments, assignments and
  // quoting never reach the trace; the full command is a deliberate expansion.
  // A stored title is trusted here only when RUNNING_TITLE accepts it, because
  // older events can carry an entire command preview as the title.
  if (SHELL_TOOLS.has(tool)) return activityDescription(block) ?? runningTitle(block, tool) ?? translate("conversation.activity.run", { target: programTarget(input, tool) });

  if (tool === "search_memory") return append(translate("conversation.activity.memory.search"));
  if (tool === "read_memory") return append(translate("conversation.activity.memory.read"), trim(text(input.id), 8));
  if (tool === "write_memory") {
    const content = record(input.content);
    return append(translate("conversation.activity.memory.write"), trim(scrubActivityText(text(content?.title) || text(input.reason))));
  }
  if (tool === "verify_citations") return translate("conversation.activity.citation.verify");
  if (tool === "read_source_evidence") return append(translate("conversation.activity.citation.read"), trim(scrubActivityText(text(input.source))));
  if (tool === "cite_evidence") {
    const selections = Array.isArray(input.selections) ? input.selections : [];
    const sources = [...new Set(selections.flatMap((selection) => text(record(selection)?.source) ? [text(record(selection)?.source)!] : []))];
    return append(translate("conversation.activity.citation.record"), activityQueryText(sources.join(", ")));
  }
  if (tool === "subagent") return append(translate("conversation.activity.delegate"), trim(scrubActivityText(text(input.agent))));
  if (tool === "subagent_control") {
    const action = text(input.action);
    return ["list", "status", "collect", "stop"].includes(action)
      ? translate(`conversation.activity.delegate.${action}`)
      : translate("conversation.activity.delegate.manage");
  }

  const purpose = activityTaskTitle(block);
  if (purpose) return purpose;
  const label = tool.replace(/[_-]+/g, " ").trim() || "tool";
  return target ? `${label} · ${target}` : label;
}

export function toolActivityCategory(block: ToolCallBlock): ActivityCategory {
  return activityCategory({ tool: block.tool, presentationKind: block.presentation?.kind, childSessionId: block.childSessionId });
}

/** What the row calls the thing that runs: the program, or the document a
 *  kernel tool opens. */
function programTarget(input: Record<string, unknown>, tool: string): string {
  const program = activityProgramName(input);
  if (program) return program;
  const path = text(input.path);
  if (KERNEL_DOCUMENTS.has(tool)) return path ? activityFileLabel(path) : "notebook";
  return tool;
}
const KERNEL_DOCUMENTS = new Set(["notebook_run", "run_cell", "execute_code", "jupyter"]);
/** A title a row may repeat for a shell call. Only the shapes the server emits
 *  pass: `Running git`, `Terminal`, or the localised equivalents. A stored
 *  command preview from an older event does not, and the program name replaces
 *  it. */
const RUNNING_TITLE = /^(?:running|terminal|正在运行|正在执行)\b/i;
function runningTitle(block: ToolCallBlock, tool: string): string | undefined {
  const value = text(block.presentation?.title) || text(block.title);
  if (!value || !RUNNING_TITLE.test(value)) return undefined;
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  if ([tool, activityToolName(tool)].some((name) => normalized === `running ${name.replace(/[_-]+/g, " ")}`)) return undefined;
  return scrubActivityText(value);
}

export function meaningfulActivityTitle(title: string | undefined, tool: string): string | undefined {
  const value = text(title);
  if (!value) return undefined;
  const normalize = (name: string) => name.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const normalizedTitle = normalize(value);
  const names = [normalize(tool), normalize(activityToolName(tool))];
  if (names.some((name) => [name, `running ${name}`, `正在运行 ${name}`, `正在执行 ${name}`].includes(normalizedTitle))) return undefined;
  return scrubActivityText(value);
}

function defaultTranslate(key: string, values: Record<string, unknown> = {}): string { return (DEFAULT_LABELS[key] ?? key).replace(/{{(\w+)}}/g, (_match, name: string) => String(values[name] ?? "")); }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function trim(value: string, max = 80): string { return value.length <= max ? value : `${value.slice(0, max - 1)}…`; }
