export const ACTIVITY_CATEGORIES = [
  "read",
  "search",
  "browse",
  "edit",
  "execute",
  "compute",
  "web",
  "literature",
  "generate",
  "delegate",
  "other",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

const TOOLS: Record<Exclude<ActivityCategory, "other">, string[]> = {
  read: ["read", "read_file", "notebook_read", "view_image"],
  search: ["grep", "rg", "search", "search_files"],
  browse: ["glob", "find", "ls", "list", "list_files"],
  edit: [
    "edit",
    "write",
    "write_file",
    "apply_patch",
    "patch",
    "notebook_edit",
    "delete",
    "delete_file",
    "move",
    "rename",
  ],
  execute: [
    "bash",
    "execute",
    "run_code",
    "pytest",
    "vitest",
    "lint",
    "typecheck",
    "build",
    "compile",
    "check",
    "test",
    "jest",
  ],
  compute: ["python", "r", "rscript", "notebook", "notebook_run", "run_cell", "execute_code"],
  web: ["web_search", "search_web", "tavily_search", "web_fetch", "fetch", "fetch_url", "read_url"],
  literature: [
    "search_pubmed",
    "search_arxiv",
    "search_crossref",
    "search_biorxiv_preprints",
    "get_europe_pmc_full_text",
    "pubmed",
    "crossref",
    "semantic_scholar",
    "search_semantic_scholar",
    "literature",
  ],
  generate: ["image_gen", "image_generation", "generate_image", "create_image", "render_image"],
  delegate: ["subagent", "subagent_control", "delegate", "spawn_agent", "task"],
};
/** The literature tools, exported so a renderer can select on the same names the
 *  glyph table uses instead of keeping a second copy that drifts. */
export const ACTIVITY_LITERATURE_TOOLS: readonly string[] = TOOLS.literature;
/** MCP tools are namespaced by the server that serves them. */
export const MCP_TOOL_PREFIX = "mcp__";
export function isMcpToolName(tool: string): boolean {
  return tool.trim().toLowerCase().startsWith(MCP_TOOL_PREFIX);
}
/** Kernel tools whose only name is the interpreter they start. */
const KERNEL_ALIASES = new Set(["r", "rscript"]);
const KINDS: Record<string, ActivityCategory> = {
  read: "read",
  search: "search",
  fetch: "web",
  edit: "edit",
  execute: "execute",
  compute: "compute",
  verify: "execute",
  artifact: "generate",
  interaction: "other",
  system: "other",
  other: "other",
};
const TOOL_CATEGORIES = new Map(
  Object.entries(TOOLS).flatMap(([category, names]) =>
    names.map((name) => [name, category as ActivityCategory]),
  ),
);
// A child session is a delegate whatever tool it ran; an exact tool name beats a
// presentation kind, so a precise mapping can refine a coarse server semantic.
// An MCP tool is classified only by what it reports about itself: its name ends
// with the server's own words, so `mcp__stats__python` would otherwise borrow the
// built-in kernel semantics and its renderer.
export function activityCategory(input: {
  tool: string;
  presentationKind?: string;
  childSessionId?: string;
}): ActivityCategory {
  if (input.childSessionId) return "delegate";
  const name = input.tool.trim().toLowerCase();
  if (!isMcpToolName(name)) {
    const exact = TOOL_CATEGORIES.get(name);
    if (exact) return exact;
    if (KERNEL_ALIASES.has(name) || name.endsWith("_kernel")) return "compute";
  }
  const kind = input.presentationKind?.toLowerCase() ?? "";
  return Object.hasOwn(KINDS, kind) ? KINDS[kind]! : "other";
}
function trim(value: string, max: number): string {
  // Count code points, not UTF-16 units: slicing by units can cut a surrogate
  // pair in half and leave an unpaired surrogate in the rendered label.
  const characters = Array.from(value);
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`;
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
export function activityFileLabel(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean);
  return trim(parts.at(-1) || path || "file", 80);
}
function lineNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 1_000_000 ? parsed : undefined;
}
export function activityReadTarget(input: Record<string, unknown>): string {
  const file = activityFileLabel(text(input.path) || text(input.file_path) || "file");
  const start = lineNumber(input.offset ?? input.start_line);
  if (start === undefined) return file;
  const limit = lineNumber(input.limit);
  if (input.limit != null && limit === undefined) return file;
  return limit === undefined ? `${file}:${start}` : `${file}:${start}-${start + limit - 1}`;
}
const DENY = new Set(
  "env export set unset exec command builtin source eval alias sudo doas nohup xargs cd if then else elif fi for while until do done case esac function declare local typeset let shift trap time nice ionice stdbuf".split(
    " ",
  ),
);
export function activityProgramName(input: Record<string, unknown>): string | undefined {
  if (typeof input.command !== "string") return undefined;
  const lines = input.command
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines[0];
  if (lines.length !== 1 || !line || /[`$|&;<>()[\]{}"'\\=!*?~#^]/.test(line)) return undefined;
  const token = line.split(/\s+/)[0] ?? "";
  const name = token.split(/[\\/]/).at(-1) ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || DENY.has(name.toLowerCase())) return undefined;
  return trim(name, 40);
}
/** A query, identifier, or subject a row can show. No credential rule runs
 *  here: `secreted protein folding` is a search, not a secret. */
export function activityQueryText(value: string, max = 80): string {
  return trim(value.replace(/\s+/g, " ").trim(), max);
}
/** The fetchable part of a URL. Userinfo and the query string are where a
 *  credential rides, and neither names the resource. */
export function activityUrlLabel(value: string, max = 120): string {
  const raw = value.trim();
  try {
    const url = new URL(raw);
    return trim(`${url.origin}${url.pathname}`.replace(/\/$/, "") || url.origin, max);
  } catch {
    return trim(raw, max);
  }
}
/** A purpose line the row may render: one line, bounded, and free of
 *  credentials. Shared so the server title and the client fallback cannot
 *  diverge. */
export function activityPurposeText(value: string): string {
  return trim(scrubActivityText(value.replace(/\s+/g, " ").trim()), 160);
}
const CREDENTIAL_SEGMENTS = new Set([
  "api",
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "key",
  "passwd",
  "passphrase",
  "password",
  "secret",
  "session",
  "token",
]);
function credentialName(name: string): boolean {
  return name
    .replace(/^-+/, "")
    .toLowerCase()
    .split(/[-_.]/)
    .some((segment) => CREDENTIAL_SEGMENTS.has(segment));
}
const ASSIGNMENT = /(\b[A-Z][A-Z0-9_]{2,})=("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s;|&"'`]+)/g;
const FLAG = /(--?[A-Za-z][\w-]*)=("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s;|&"'`]+)/g;
/** Remove a credential from text that will be rendered as a title.
 *
 *  A name must carry a credential `word` to match, so a scientific term that
 *  merely contains one (`secreted`, `secretory`, `token binding`) survives
 *  untouched. Unlabelled secrets stay out of reach by design; the shell row
 *  never repeats arguments at all. */
export function scrubActivityText(value: string): string {
  return value
    .replace(ASSIGNMENT, (match, name: string, assigned: string) =>
      credentialName(name) || assigned.length >= 20 ? `${name}=[redacted]` : match,
    )
    .replace(FLAG, (match, flag: string) => (credentialName(flag) ? `${flag}=[redacted]` : match))
    .replace(/(\bAuthorization\s*:\s*)([^;"'`\n]+)/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [redacted]")
    .replace(/\b(https?:\/\/)[^\s/@"'`]+@/gi, "$1");
}
