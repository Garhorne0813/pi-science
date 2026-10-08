import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { PiConfig } from "@pi-science/contracts";
import { configRoot, metadataRoot } from "../../storage/persistence.js";
export function seedWorkspaceAssets(cwd: string): string[] {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
  // Legacy workspaces still keep state under .pi-science. Never follow a
  // foreign marker there; registered projects use the relocated state root.
  if (metadataRoot(cwd) === join(cwd, ".pi-science")) {
    replaceForeignEntry(join(cwd, ".pi-science"));
    mkdirSync(join(cwd, ".pi-science"), { recursive: true });
  }
  // The workspace-local .pi directory contains the skills exposed to Pi.
  replaceForeignEntry(join(cwd, ".pi"));
  const sourceSkills = join(projectRoot, "skills");
  const targetSkills = join(cwd, ".pi", "skills");
  // The .pi/skills tree is managed state: if a previous seed or the runtime
  // left a symlink (or plain file) here, remove it first. Never seed through
  // a symlink — it would write to and delete from wherever the link points.
  replaceForeignEntry(targetSkills);
  mkdirSync(targetSkills, { recursive: true });
  const result: string[] = [];
  // The packaged checkout may ship without a skills/ directory (source-only
  // archives). Missing project skills must not break session creation.
  if (!existsSync(sourceSkills)) return result;
  for (const name of readdirSync(sourceSkills, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const skillMarkdown = join(sourceSkills, name.name, "SKILL.md");
    let skillMdInfo;
    try {
      skillMdInfo = lstatSync(skillMarkdown);
    } catch {
      continue;
    }
    // Refuse to seed from a symlinked SKILL.md; only real files count.
    if (!skillMdInfo.isFile()) continue;
    const source = join(sourceSkills, name.name);
    const target = join(targetSkills, name.name);
    seedSkillTree(source, target);
    result.push(target);
  }
  return result;
}

// Remove a symlink or non-directory blocking a managed directory path so
// mkdirSync/cpSync below never follows or collides with a foreign entry.
function replaceForeignEntry(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    rmSync(path, { recursive: true, force: true });
  }
}

// Mirror a builtin skill into the workspace .pi/skills/ tree. Copies the
// whole directory (SKILL.md plus helpers, references, assets, and requirement
// manifests) so scripted skills work offline; refuses symlinks and anything
// escaping the skill directory; and removes stale entries that no longer
// exist upstream so removed helpers cannot linger in workspaces.
function seedSkillTree(source: string, target: string): void {
  // The tree root is managed state: a symlink (or file) left here by a
  // previous seed or the runtime is removed before anything is written —
  // never write through it, and never let stale-entry cleanup delete from
  // wherever it points.
  replaceForeignEntry(target);
  mkdirSync(target, { recursive: true });
  const pending: Array<{ source: string; target: string }> = [{ source, target }];
  while (pending.length > 0) {
    const { source: from, target: to } = pending.pop()!;
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") continue;
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      // Never follow symlinks from the skill tree, and never write through a
      // symlink that a previous seed or the runtime may have left behind.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // Directory entries are written later (children), so guard the target
        // now: a stale symlink here would let later writes leak outside, and
        // a foreign file would break directory creation with ENOTDIR.
        let info;
        try {
          info = lstatSync(toPath);
        } catch {
          /* missing: fine */
        }
        if (info && (info.isSymbolicLink() || !info.isDirectory())) {
          rmSync(toPath, { recursive: true, force: true });
        }
        pending.push({ source: fromPath, target: toPath });
      } else if (entry.isFile()) {
        removeUnlinkable(toPath);
        cpSync(fromPath, toPath);
      }
    }
  }
  removeStaleEntries(source, target);
}

// Remove a symlink or a directory in the way of an incoming file (and a file
// in the way of an incoming directory, handled by the recursive rm below) so
// cpSync never follows or collides with a foreign entry.
function removeUnlinkable(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || info.isDirectory()) rmSync(path, { recursive: true, force: true });
}

function removeStaleEntries(source: string, target: string): void {
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return;
  }
  for (const name of entries) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    let targetInfo;
    try {
      targetInfo = lstatSync(targetPath);
    } catch {
      continue;
    }
    if (targetInfo.isSymbolicLink()) {
      console.warn(`[pi-science] removing stale seeded entry: ${targetPath} (foreign symlink)`);
      rmSync(targetPath, { recursive: true, force: true });
      continue;
    }
    let sourceInfo;
    try {
      sourceInfo = statSync(sourcePath);
    } catch {
      // No upstream counterpart: the entry is stale (or the upstream tree
      // changed shape), so drop it to keep the mirror exact.
      console.warn(`[pi-science] removing stale seeded entry: ${targetPath} (no upstream counterpart)`);
      rmSync(targetPath, { recursive: true, force: true });
      continue;
    }
    if (targetInfo.isDirectory() && sourceInfo.isDirectory()) {
      removeStaleEntries(sourcePath, targetPath);
    } else if (targetInfo.isDirectory() !== sourceInfo.isDirectory()) {
      console.warn(`[pi-science] removing stale seeded entry: ${targetPath} (type mismatch with upstream)`);
      rmSync(targetPath, { recursive: true, force: true });
    }
  }
}

export function loadDefaultPiConfig(): PiConfig {
  const dataRoot = configRoot();
  const settings = readSettings(dataRoot);
  return {
    model: typeof settings.model === "string" && settings.model ? settings.model : null,
    thinking: typeof settings.thinking === "string" && settings.thinking ? settings.thinking : null,
    compaction_enabled: settings.compaction_enabled !== false,
    compaction_threshold_percent: validThreshold(settings.compaction_threshold_percent),
    model_context_window: positiveInteger(settings.model_context_window),
    model_context_window_override: typeof settings.model_context_window_override?.model === "string"
      && positiveInteger(settings.model_context_window_override.context_window)
      ? { model: settings.model_context_window_override.model, context_window: positiveInteger(settings.model_context_window_override.context_window)! } : undefined,
    model_max_output_tokens: positiveInteger(settings.model_max_output_tokens),
    provider: null,
    api_key: null,
    skills: Array.isArray(settings.skill_paths) ? settings.skill_paths.map(String).filter(Boolean) : [],
    extensions: [],
  };
}
function readSettings(dataRoot: string): Record<string, any> {
  try { return JSON.parse(readFileSync(join(resolve(dataRoot), "config.json"), "utf8")) as Record<string, any>; }
  catch { return {}; }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validThreshold(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 95 ? parsed : undefined;
}
