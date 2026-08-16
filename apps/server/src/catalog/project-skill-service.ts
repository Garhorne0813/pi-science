/**
 * Project-scoped skill mutations for the settings Skills tab.
 *
 * New skills always land under `<workspace>/.pi/skills/<name>/` so they are
 * discovered as `source: "project"` with project-over-builtin precedence.
 * The service deliberately refuses to touch user or builtin skill roots.
 */

import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import JSZip from "jszip";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { skillMetadataSchema, type SkillInfo } from "@pi-science/contracts";
import { recordEgress, egressAuditEnabled } from "../security/egress-audit.js";
import { safeConnectorFetch } from "../security/outbound-security.js";
import { pathIsInside } from "../support/platform-utils.js";
import { catalog, discover, parseSkill, type DiscoveredSkill } from "./skill-catalog.js";

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_TREE_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5_000;
export const MAX_ZIP_DEPTH = 32;

export interface ProjectSkillInput {
  name: string;
  description: string;
  body?: string;
  version?: string;
  license?: string;
  category?: string;
  requirements?: Array<{ name: string; kind?: string; optional?: boolean; version?: string | null }>;
}

export interface UploadedSkillFile {
  /** Relative path inside the skill directory, always posix-style. */
  path: string;
  content: Buffer;
  size: number;
}

export interface SkillUploadCandidate {
  /** Skill name derived from the SKILL.md frontmatter. */
  name: string;
  /** The zip-relative directory that contains this SKILL.md. */
  root_path: string;
  description: string;
  files: Array<{ path: string; size: number }>;
}

export interface GithubSkillCandidate {
  name: string;
  root_path: string;
  description: string;
  files: Array<{ path: string; size: number }>;
}

export function slugifySkillName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function validateSkillName(value: string): string | null {
  if (!value) return "Skill name is required";
  if (!SKILL_NAME_PATTERN.test(value)) {
    return "Skill name must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, underscores and hyphens";
  }
  if (value.length > 80) return "Skill name must be 80 characters or fewer";
  return null;
}

export function projectSkillRoot(cwd: string): string {
  return resolve(cwd, ".pi", "skills");
}

export function projectSkillDir(cwd: string, name: string): string {
  if (validateSkillName(name)) throw new Error("Invalid skill name");
  return join(projectSkillRoot(cwd), name);
}

function assertInsideProjectSkills(cwd: string, target: string): void {
  const root = projectSkillRoot(cwd);
  if (!pathIsInside(root, target, true)) {
    throw new Error("Skill path must remain inside the project .pi/skills directory");
  }
}

/** Guard writes against symlink escapes: every existing ancestor of `target`
 *  must resolve to a real directory still inside the project `.pi/skills`
 *  root, and no traversal component may itself be a symbolic link. */
async function assertSafeProjectPath(cwd: string, target: string): Promise<void> {
  const root = projectSkillRoot(cwd);
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  assertInsideProjectSkills(cwd, target);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === "") {
    throw new Error("Skill path must remain inside the project .pi/skills directory");
  }
  let current = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) {
      throw new Error("Skill path must not traverse symlinks");
    }
    if (info) {
      const currentReal = await realpath(current);
      if (!pathIsInside(rootReal, currentReal, true)) {
        throw new Error("Skill path escapes the project skills directory");
      }
    } else {
      break;
    }
  }
  const finalReal = await realpath(target).catch(() => null);
  if (finalReal && !pathIsInside(rootReal, finalReal, true)) {
    throw new Error("Skill path escapes the project skills directory");
  }
}



function yamlFrontMatter(input: ProjectSkillInput, name: string): string {
  const metadata = {
    name,
    description: input.description,
    version: input.version ?? "0.1.0",
    license: input.license ?? "Apache-2.0",
    category: input.category ?? "general",
    ...(input.requirements?.length ? { requirements: input.requirements } : {}),
  };
  const parsed = skillMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid skill metadata: ${detail || "validation failed"}`);
  }
  return stringifyYaml(parsed.data).trimEnd();
}

export function buildSkillMarkdown(input: ProjectSkillInput, name: string): string {
  const body = (input.body ?? "").trim();
  return `---\n${yamlFrontMatter(input, name)}\n---\n\n${body}\n`;
}

async function writeSkillTree(cwd: string, files: UploadedSkillFile[]): Promise<DiscoveredSkill> {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new Error("Bundle must contain SKILL.md at the skill root");
  const front = parseYaml(skillFile.content.toString("utf8").replace(/\r\n/g, "\n").match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1] ?? "") as Record<string, unknown> | null;
  const metadataResult = skillMetadataSchema.safeParse(front ?? {});
  if (!metadataResult.success) {
    const detail = metadataResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid SKILL.md front matter: ${detail || "validation failed"}`);
  }
  const name = metadataResult.data.name;
  const dir = projectSkillDir(cwd, name);
  await assertSafeProjectPath(cwd, dir);
  const info = await stat(dir).catch(() => null);
  if (info?.isDirectory()) {
    const existing = join(dir, "SKILL.md");
    const exists = await stat(existing).catch(() => null);
    if (exists) throw new Error(`Skill '${name}' already exists in this project`);
  }
  await mkdir(dir, { recursive: true });
  try {
    for (const file of files) {
      const target = resolve(dir, ...file.path.split("/"));
      await assertSafeProjectPath(cwd, target);
      if (file.path === "SKILL.md") {
        await writeFile(target, file.content, { flag: "wx" });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return parseSkill(join(dir, "SKILL.md"), "project", projectSkillRoot(cwd));
}

async function toProjectSkillInfo(cwd: string, name: string): Promise<SkillInfo> {
  const skill = (await catalog(cwd)).find((item) => item.name === name && item.source === "project");
  if (!skill) throw new Error("Project skill not found after write");
  return skill;
}

async function writeProjectSkill(cwd: string, name: string, input: ProjectSkillInput): Promise<SkillInfo> {
  const nameError = validateSkillName(name);
  if (nameError) throw new Error(nameError);
  if (!input.description?.trim()) throw new Error("description is required");
  const dir = projectSkillDir(cwd, name);
  const fileTarget = join(dir, "SKILL.md");
  await assertSafeProjectPath(cwd, fileTarget);
  const existing = await stat(fileTarget).catch(() => null);
  if (existing) throw new Error(`Skill '${name}' already exists in this project`);
  const content = Buffer.from(buildSkillMarkdown(input, name), "utf8");
  await mkdir(dir, { recursive: true });
  await writeFile(fileTarget, content, { flag: "wx" });
  return toProjectSkillInfo(cwd, name);
}

async function updateProjectSkill(cwd: string, skillIdOrName: string, input: ProjectSkillInput): Promise<SkillInfo> {
  const records = await discover(cwd);
  const record = records.find((skill) => (skill.skillId === skillIdOrName || skill.metadata.name === skillIdOrName) && skill.source === "project");
  if (!record) throw new Error("Project skill not found");
  const dir = dirname(record.sourcePath);
  const name = record.metadata.name;
  const existing = await readFile(join(dir, "SKILL.md"), "utf8");
  const frontRaw = existing.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1] ?? "";
  const front = parseYaml(frontRaw) as Record<string, unknown> | null ?? {};
  const merged = {
    ...front,
    name,
    description: input.description?.trim() ? input.description.trim() : String(front.description ?? ""),
    ...(input.version ? { version: input.version } : {}),
    ...(input.license ? { license: input.license } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.requirements ? { requirements: input.requirements } : {}),
  };
  const parsed = skillMetadataSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid skill metadata: ${detail || "validation failed"}`);
  }
  const body = input.body ?? existing.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").replace(/^\n/, "");
  const markdown = `---\n${stringifyYaml(parsed.data).trimEnd()}\n---\n\n${body.trim()}\n`;
  const fileTarget = join(dir, "SKILL.md");
  await assertSafeProjectPath(cwd, fileTarget);
  await writeFile(fileTarget, Buffer.from(markdown, "utf8"));
  return toProjectSkillInfo(cwd, name);
}

async function deleteProjectSkill(cwd: string, skillIdOrName: string): Promise<{ name: string }> {
  const records = await discover(cwd);
  const record = records.find((skill) => (skill.skillId === skillIdOrName || skill.metadata.name === skillIdOrName) && skill.source === "project");
  if (!record) throw new Error("Project skill not found");
  const dir = dirname(record.sourcePath);
  await assertSafeProjectPath(cwd, dir);
  await rm(dir, { recursive: true, force: true });
  return { name: record.metadata.name };
}

export function normalizeZipPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return ".";
  if (normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`Unsafe path in bundle: ${path}`);
  }
  if (/^[A-Za-z]:/.test(normalized)) throw new Error(`Unsafe path in bundle: ${path}`);
  return normalized;
}

export async function previewSkillUpload(filename: string, content: Buffer): Promise<SkillUploadCandidate[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) {
    if (content.length > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md exceeds the file size limit");
    const text = content.toString("utf8");
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) throw new Error("SKILL.md must start with YAML front matter");
    const parsed = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
    const metadataResult = skillMetadataSchema.safeParse(parsed ?? {});
    if (!metadataResult.success) {
      const detail = metadataResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`Invalid SKILL.md front matter: ${detail || "validation failed"}`);
    }
    const metadata = metadataResult.data;
    return [{ name: metadata.name, root_path: ".", description: metadata.description, files: [{ path: "SKILL.md", size: content.length }] }];
  }
  if (!lower.endsWith(".zip") && !lower.endsWith(".skill")) {
    throw new Error("Unsupported skill upload: expected .md, .zip or .skill");
  }
  const zip = await JSZip.loadAsync(content);
  const entries: Array<{ path: string; dir: boolean }> = [];
  zip.forEach((path, entry) => {
    const safe = normalizeZipPath(path);
    if (safe.split("/").length > MAX_ZIP_DEPTH) throw new Error(`Bundle path is too deep: ${path}`);
    entries.push({ path: safe, dir: entry.dir });
  });
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error("Bundle contains too many entries");
  const skills = new Map<string, SkillUploadCandidate>();
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.dir || !entry.path.endsWith("SKILL.md")) continue;
    const rootPath = entry.path.slice(0, -"SKILL.md".length).replace(/\/$/, "") || ".";
    const file = zip.file(entry.path);
    if (!file) continue;
    const text = await file.async("string");
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match) continue;
    const parsed = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
    const metadataResult = skillMetadataSchema.safeParse(parsed ?? {});
    if (!metadataResult.success) continue;
    const metadata = metadataResult.data;
    const name = metadata.name;
    const description = metadata.description;
    const files: Array<{ path: string; size: number }> = [];
    let skillBytes = 0;
    for (const item of entries) {
      if (item.dir) continue;
      const inRoot = rootPath === "." ? item.path !== "SKILL.md" : (item.path === rootPath || item.path.startsWith(`${rootPath}/`)) && item.path !== entry.path;
      if (!inRoot) continue;
      const itemFile = zip.file(item.path);
      if (!itemFile) continue;
      const buffer = await itemFile.async("nodebuffer");
      if (buffer.length > MAX_SKILL_FILE_BYTES) throw new Error(`Bundled file is too large: ${item.path}`);
      skillBytes += buffer.length;
      if (skillBytes > MAX_SKILL_TREE_BYTES || totalBytes + skillBytes > MAX_SKILL_TREE_BYTES) throw new Error("Bundle exceeds the total size limit");
      files.push({ path: rootPath === "." ? item.path : item.path.slice(rootPath.length + 1), size: buffer.length });
    }
    skillBytes += text.length;
    if (skillBytes > MAX_SKILL_TREE_BYTES || totalBytes + skillBytes > MAX_SKILL_TREE_BYTES) throw new Error("Bundle exceeds the total size limit");
    files.push({ path: "SKILL.md", size: text.length });
    totalBytes += skillBytes;
    skills.set(rootPath, { name, root_path: rootPath, description, files });
  }
  if (skills.size === 0) throw new Error("No valid skill found in bundle (expected SKILL.md with valid name and description)");
  return [...skills.values()];
}

export async function importSkillBundle(cwd: string, filename: string, content: Buffer, rootPath: string): Promise<SkillInfo> {
  const lower = filename.toLowerCase();
  let files: UploadedSkillFile[];
  if (lower.endsWith(".md")) {
    if (rootPath && rootPath !== ".") throw new Error("root_path must be omitted for a single SKILL.md upload");
    const candidate = (await previewSkillUpload(filename, content))[0];
    if (!candidate) throw new Error("Invalid SKILL.md upload");
    files = [{ path: "SKILL.md", content, size: content.length }];
  } else {
    const zip = await JSZip.loadAsync(content);
    const candidates = await previewSkillUpload(filename, content);
    const selected = candidates.find((candidate) => candidate.root_path === rootPath);
    if (!selected) throw new Error("Selected skill root not found in bundle");
    const prefix = selected.root_path === "." ? "" : `${selected.root_path}/`;
    files = [];
    for (const fileEntry of selected.files) {
      const fullPath = `${prefix}${fileEntry.path}`;
      const entry = zip.file(fullPath);
      if (!entry || entry.dir) continue;
      const buffer = await entry.async("nodebuffer");
      if (buffer.length > MAX_SKILL_FILE_BYTES) {
        throw new Error(`Bundled file is too large: ${fileEntry.path}`);
      }
      files.push({ path: fileEntry.path, content: buffer, size: buffer.length });
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_SKILL_TREE_BYTES) throw new Error("Bundled skill exceeds the total size limit");
  }
  const record = await writeSkillTree(cwd, files);
  return toProjectSkillInfo(cwd, record.metadata.name);
}

export async function parseGithubRepo(input: string): Promise<{ owner: string; repo: string; ref: string | null }> {
  let value = input.trim();
  if (!value) throw new Error("GitHub repository is required");
  const urlMatch = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/.*)?)?/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!.replace(/\.git$/i, ""),
      ref: urlMatch[3] ?? null,
    };
  }
  const shorthand = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:@(.+))?$/);
  if (!shorthand) throw new Error("Expected owner/repo, owner/repo@ref, or a github.com URL");
  return { owner: shorthand[1]!, repo: shorthand[2]!.replace(/\.git$/i, ""), ref: shorthand[3] ?? null };
}

function githubApiBase(): string {
  return process.env.PI_SCIENCE_GITHUB_API_BASE ?? "https://api.github.com";
}

function githubRawBase(): string {
  return process.env.PI_SCIENCE_GITHUB_RAW_BASE ?? "https://raw.githubusercontent.com";
}

async function recordGithubEgress(url: string): Promise<void> {
  if (await egressAuditEnabled()) {
    await recordEgress({ connector_type: "connector", connector_id: "github-skills-import", target_domain: url, approved: true });
  }
}

async function fetchJson(url: string): Promise<{ tree: Array<{ path?: string; type?: string; size?: number }> }> {
  await recordGithubEgress(url);
  const response = await safeConnectorFetch(url, {
    timeoutMs: 15_000,
    maxResponseBytes: 10 * 1024 * 1024,
    allowPrivate: false,
    allowedContentTypes: ["application/json"],
    headers: { accept: "application/vnd.github+json", "user-agent": "pi-science" },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<{ tree: Array<{ path?: string; type?: string; size?: number }> }>;
}

async function fetchRaw(url: string, maxBytes = MAX_SKILL_FILE_BYTES): Promise<Buffer> {
  await recordGithubEgress(url);
  const response = await safeConnectorFetch(url, {
    timeoutMs: 15_000,
    maxResponseBytes: maxBytes,
    allowPrivate: false,
    headers: { "user-agent": "pi-science" },
  });
  if (!response.ok) {
    throw new Error(`GitHub raw request failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function previewGithubSkills(repoInput: string): Promise<GithubSkillCandidate[]> {
  const { owner, repo, ref } = await parseGithubRepo(repoInput);
  const tree = await fetchJson(`${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref ?? "HEAD")}?recursive=1`);
  const candidates: GithubSkillCandidate[] = [];
  const byRoot = new Map<string, { name: string; description: string; files: Array<{ path: string; size: number }> }>();
  for (const entry of tree.tree) {
    const path = entry.path ?? "";
    if (entry.type === "blob" && path.endsWith("/SKILL.md")) {
      const rootPath = path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
      const name = rootPath.split("/").at(-1) ?? "";
      byRoot.set(rootPath, { name, description: "", files: [] });
    }
  }
  for (const entry of tree.tree) {
    const path = entry.path ?? "";
    if (entry.type !== "blob") continue;
    for (const root of byRoot.keys()) {
      if (path === `${root}/SKILL.md` || path.startsWith(`${root}/`)) {
        const rel = path.slice(root.length + 1);
        byRoot.get(root)!.files.push({ path: rel, size: entry.size ?? 0 });
      }
    }
  }
  for (const [root, candidate] of byRoot) {
    const skillMdPath = `${root}/SKILL.md`;
    const rawPath = skillMdPath.split("/").map(encodeURIComponent).join("/");
    const rawUrl = `${githubRawBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref ?? "HEAD")}/${rawPath}`;
    try {
      const buffer = await fetchRaw(rawUrl);
      const text = buffer.toString("utf8");
      const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
      const parsed = match ? parseYaml(match[1] ?? "") as Record<string, unknown> | null : null;
      if (parsed && typeof parsed.description === "string") candidate.description = parsed.description;
    } catch { /* keep empty description when metadata cannot be fetched */ }
    candidates.push({ name: candidate.name || slugifySkillName(root), root_path: root, description: candidate.description, files: candidate.files });
  }
  return candidates.sort((a, b) => a.root_path.localeCompare(b.root_path));
}

export async function importGithubSkills(cwd: string, repoInput: string, selected: string[]): Promise<{ imported: SkillInfo[]; skipped: Array<{ name: string; reason: string }> }> {
  const { owner, repo, ref } = await parseGithubRepo(repoInput);
  const tree = await fetchJson(`${githubApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref ?? "HEAD")}?recursive=1`);
  const imported: SkillInfo[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const root of selected) {
    const files = tree.tree
      .filter((entry) => entry.type === "blob" && (entry.path === `${root}/SKILL.md` || entry.path?.startsWith(`${root}/`)))
      .map((entry) => ({ path: entry.path!.slice(root.length + 1) as string, size: entry.size ?? 0 }));
    const skillFile = files.find((file) => file.path === "SKILL.md");
    const name = root.split("/").at(-1) ?? "";
    if (!skillFile || !name) {
      skipped.push({ name: name || root, reason: "No SKILL.md found at the selected path" });
      continue;
    }
    try {
      const loaded: UploadedSkillFile[] = [];
      let total = 0;
      for (const file of files) {
        if (file.size > MAX_SKILL_FILE_BYTES) throw new Error(`${file.path} exceeds the file size limit`);
        total += file.size;
        if (total > MAX_SKILL_TREE_BYTES) throw new Error("Imported skill exceeds the total size limit");
        const rawPath = `${root}/${file.path}`.split("/").map(encodeURIComponent).join("/");
        const url = `${githubRawBase()}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref ?? "HEAD")}/${rawPath}`;
        const buffer = await fetchRaw(url);
        loaded.push({ path: file.path, content: buffer, size: buffer.length });
      }
      const record = await writeSkillTree(cwd, loaded);
      imported.push(await toProjectSkillInfo(cwd, record.metadata.name));
    } catch (error) {
      skipped.push({ name: name || root, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { imported, skipped };
}

export { writeProjectSkill as createProjectSkill };
export { updateProjectSkill };
export { deleteProjectSkill };
export { writeSkillTree };