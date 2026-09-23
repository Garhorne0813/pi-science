/** Pure workspace path helpers shared by every automatic file surface.
 *
 *  The same workspace file is spelled three ways in real traffic:
 *  `<cwd>/figures/a.png` (absolute, what the run cwd makes models produce),
 *  `/figures/a.png` (workspace-root shorthand, used in markdown links) and
 *  `figures/a.png` (workspace-relative, what runtime events publish). Every
 *  automatic probe/serve route rejects the absolute form, so both callers —
 *  the markdown resolver and artifact reference discovery — map paths through
 *  the same helpers instead of each guessing. */

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Pure POSIX-style normalization for absolute forms: collapses `.` and
 *  resolves `..` against the root (never climbs above `/`). Relative inputs
 *  are resolved like posix.normalize (leading `..` segments survive). */
export function posixNormalize(value: string): string {
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
export const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** Strip a workspace cwd prefix. The drive letter is compared
 *  case-insensitively (Windows `C:` vs `c:`); everything else is exact.
 *  Returns the workspace-relative path or null when the candidate is not
 *  under cwd. */
export function stripCwdPrefix(candidate: string, cwd: string): string | null {
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

/** Absolute filesystem path of a workspace-relative entry — the spelling a
 *  terminal, a file dialog or a script outside the workspace needs. The copied
 *  separator follows the workspace platform, so a Windows cwd yields a path
 *  that pastes straight into Explorer or PowerShell. */
export function absoluteWorkspacePath(cwd: string, path: string): string {
  const base = normalizeSlashes(cwd).replace(/\/+$/, "");
  const leaf = normalizeSlashes(path).replace(/^\/+/, "");
  const absolute = !base ? leaf : leaf ? `${base}/${leaf}` : base;
  return WINDOWS_DRIVE.test(base) && !base.startsWith("/") ? absolute.replace(/\//g, "\\") : absolute;
}

/** Map a path spelled in agent text or a runtime event onto a workspace-relative
 *  path, the only spelling automatic probe/serve routes accept.
 *
 *  A path under cwd loses the cwd prefix; an absolute path outside cwd keeps
 *  its previous meaning as the workspace-root shorthand (`/figures/a.png`), the
 *  same rule the markdown resolver applies to links. An absolute path whose
 *  `..` segments climb out of the workspace cannot name a workspace file and
 *  resolves to null. Paths that are already relative pass through unchanged. */
export function toWorkspaceRelativePath(path: string, cwd: string): string | null {
  const candidate = normalizeSlashes(path);
  if (!candidate) return null;
  const base = normalizeSlashes(cwd).replace(/\/+$/, "");
  if (!base) return candidate.replace(/^\.\//, "");
  if (WINDOWS_DRIVE.test(candidate)) {
    // Windows absolute (`C:\figures\a.png` / `C:/Users/.../test/figures/a.png`):
    // drop the drive from both sides, then treat the remainder like a
    // workspace-root path.
    const resolved = candidate.replace(WINDOWS_DRIVE, "");
    const baseDriveStripped = base.replace(WINDOWS_DRIVE, "");
    return stripCwdPrefix(resolved, baseDriveStripped) ?? resolved.replace(/^\/+/, "");
  }
  if (!candidate.startsWith("/")) return candidate.replace(/^\.\//, "");
  // Absolute form: either a real workspace path under cwd, or the
  // workspace-root shorthand. Normalize `.`/`..` first so `/figures/../../etc/x`
  // cannot smuggle `..` segments into the workspace-relative result.
  const normalized = posixNormalize(candidate);
  const prefixPath = stripCwdPrefix(normalized, base);
  if (prefixPath === null && candidate.split("/").some((segment) => segment === "..")) return null;
  return prefixPath ?? normalized.replace(/^\/+/, "");
}
