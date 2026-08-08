/** Resolve image/link references inside rendered markdown to workspace file
 *  URLs (or pass through external URLs untouched).
 *
 *  Without this, `![fig](./images/plot.png)` inside a previewed markdown
 *  document is handed to the browser as a relative SPA URL and 404s — the
 *  document has no idea that `./images/plot.png` is a workspace file. The
 *  resolver answers three questions:
 *   - is this an external URL (http/https/data/blob/mailto) → keep as-is?
 *   - does this reference a workspace file → which path, and what serve URL?
 *   - is it unresolvable / escaping the workspace → invalid (caller shows a
 *     placeholder instead of a broken image). */

import { previewUrl, type FileRoot } from "./files";

export interface MarkdownResourceContext {
  /** Workspace root (absolute filesystem path, any platform separators). */
  cwd: string;
  /** FileRoot override for the preview URL (defaults to workspace). */
  root?: FileRoot;
  /** Absolute workspace path of the document being rendered. Relative
   *  references (`./images/a.png`, `../figures/b.png`) resolve against the
   *  document's directory when present; without it they are workspace-relative. */
  documentPath?: string;
}

export type MarkdownResource =
  | { kind: "external"; url: string }
  | { kind: "workspace"; path: string; url: string }
  | { kind: "invalid" };

/** External URL schemes that the browser can load on its own. `file:` is NOT
 *  included: this is a web-only app that can never load local files, so a
 *  file:// reference is invalid rather than external. */
const EXTERNAL_SCHEME = /^(?:https?:|mailto:|data:|blob:)/i;
const FILE_SCHEME = /^file:/i;

/** Split off the query/fragment before encoding — they must survive verbatim. */
function splitQueryFragment(href: string): { clean: string; suffix: string } {
  const q = href.search(/[?#]/);
  if (q === -1) return { clean: href, suffix: "" };
  return { clean: href.slice(0, q), suffix: href.slice(q) };
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Join path segments, collapsing `.` and resolving `..` without ever going
 *  above the base directory (escaping yields null). An absolute base keeps
 *  its leading slash; a Windows drive prefix survives as a plain segment. */
function joinWithin(baseDir: string, relative: string): string | null {
  const absolute = baseDir.startsWith("/");
  const parts: string[] = [];
  for (const segment of `${baseDir}/${relative}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}

/** Pure POSIX-style normalization for absolute forms: collapses `.` and
 *  resolves `..` against the root (never climbs above `/`). Relative inputs
 *  are resolved like posix.normalize (leading `..` segments survive). */
function posixNormalize(value: string): string {
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined;
}

/** Windows drive prefix (`C:`, `c:` — case-insensitive). */
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** Strip a workspace cwd prefix. The drive letter is compared
 *  case-insensitively (Windows `C:` vs `c:`); everything else is exact.
 *  Returns the workspace-relative path or null when the candidate is not
 *  under cwd. */
function stripCwdPrefix(candidate: string, cwd: string): string | null {
  const prefix = `${cwd}/`;
  if (candidate === cwd) return null;
  if (candidate.startsWith(prefix)) return candidate.slice(prefix.length);
  if (WINDOWS_DRIVE.test(prefix) && WINDOWS_DRIVE.test(candidate)) {
    // Compare drive-less forms so `c:` vs `C:` (and optional leading slash
    // after the drive) never matters.
    const candidateRest = candidate.replace(WINDOWS_DRIVE, "").replace(/^\/+/, "");
    const prefixRest = prefix.replace(WINDOWS_DRIVE, "").replace(/^\/+/, "");
    if (candidateRest.startsWith(prefixRest)) return candidateRest.slice(prefixRest.length);
  }
  return null;
}

/** Resolve a markdown href against the given document/workspace context. */
export function resolveMarkdownResource(href: string, context: MarkdownResourceContext): MarkdownResource {
  const raw = href.trim();
  if (!raw || raw.startsWith("#")) return { kind: "invalid" };
  if (FILE_SCHEME.test(raw)) return { kind: "invalid" };
  if (EXTERNAL_SCHEME.test(raw)) return { kind: "external", url: raw };

  const cwd = normalizeSlashes(context.cwd).replace(/\/+$/, "");
  if (!cwd) return { kind: "invalid" };
  const { clean, suffix } = splitQueryFragment(raw);
  const candidate = normalizeSlashes(clean);

  let workspacePath: string | null = null;
  let resolved: string;

  if (WINDOWS_DRIVE.test(candidate)) {
    // Windows absolute (`C:\figures\a.png` / `C:/Users/.../test/figures/a.png`):
    // drop the drive from both sides, then treat the remainder like a
    // workspace-root path.
    resolved = candidate.replace(WINDOWS_DRIVE, "");
    const cwdDriveStripped = cwd.replace(WINDOWS_DRIVE, "");
    workspacePath = stripCwdPrefix(resolved, cwdDriveStripped) ?? resolved.replace(/^\/+/, "");
  } else if (candidate.startsWith("/")) {
    // Absolute form: either a real workspace path under cwd, or the
    // workspace-root shorthand (`/figures/a.png`). Normalize `.`/`..` first
    // so `/figures/../../etc/passwd` cannot smuggle `..` segments into the
    // workspace-relative result; a `..` path that normalizes OUTSIDE the cwd
    // prefix (root shorthand) is rejected as invalid.
    const normalized = normalizeSlashes(posixNormalize(candidate));
    const hasDotDot = candidate.split("/").some((segment) => segment === "..");
    resolved = normalized;
    const prefixPath = stripCwdPrefix(resolved, cwd);
    workspacePath = prefixPath ?? resolved.replace(/^\/+/, "");
    if (hasDotDot && prefixPath === null) return { kind: "invalid" };
  } else {
    // Relative form: resolve against the document directory when known
    // (documentPath is a workspace-relative path, so anchor it to cwd),
    // otherwise against the workspace root. `..` escaping the base is invalid.
    const rawDoc = context.documentPath ? normalizeSlashes(context.documentPath) : undefined;
    const docAbs = rawDoc && !rawDoc.startsWith("/") && !WINDOWS_DRIVE.test(rawDoc)
      ? `${cwd}/${rawDoc}`
      : rawDoc;
    const baseDir = docAbs ? docAbs.split("/").slice(0, -1).join("/") : "";
    const joined = joinWithin(baseDir, candidate);
    if (joined === null) return { kind: "invalid" };
    workspacePath = baseDir ? stripCwdPrefix(joined, cwd) : joined;
  }

  if (!workspacePath) return { kind: "invalid" };
  // The serve URL always carries ?cwd=…, so a query in the original href
  // must be joined with `&` instead of a second `?`. Fragments append as-is.
  const base = previewUrl(workspacePath, context.root, context.cwd);
  const url = suffix ? `${base}${suffix.startsWith("?") ? `&${suffix.slice(1)}` : suffix}` : base;
  return { kind: "workspace", path: workspacePath, url };
}
