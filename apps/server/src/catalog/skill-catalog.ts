/**
 * Discovery, validation, and metadata for Pi-Science skills.
 *
 * Ported from backend/services/skill_catalog.py. Uses a real YAML parser
 * (not hand-rolled key/value splitting) and scans project + user + builtin
 * sources with precedence-based deduplication.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  skillMetadataSchema,
  type SkillContent,
  type SkillFile,
  type SkillInfo,
  type SkillMetadata,
  type SkillValidation,
} from "@pi-science/contracts";
import { pathIsInside } from "../support/platform-utils.js";

const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const SOURCE_RANK: Record<string, number> = { project: 0, user: 1, builtin: 2 };
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 512 * 1024;
// Claude Code Agent Skills top-level fields that pi-science parses but does
// not enforce. Accepting them keeps front matter parseable, but surfacing a
// warning prevents authors from believing Claude-only semantics apply here.
const CLAUDE_ONLY_FIELDS = ["allowed-tools", "disable-model-invocation", "model"];
// Progressive disclosure budget: the description is surfaced to the model at
// discovery time, so an overlong one inflates every conversation's context.
const MAX_DESCRIPTION_BYTES = 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/ (or dist/) -> apps/server/ -> apps/ -> project root
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");
function builtinSkillsDir(): string {
  return process.env.PI_SCIENCE_SKILLS_DIR ?? join(PROJECT_ROOT, "skills");
}

export interface DiscoveredSkill {
  sourcePath: string;
  sourceRoot: string;
  source: string;
  metadata: SkillMetadata;
  validation: SkillValidation;
  digest: string;
  skillId: string;
  files: SkillFile[];
}

function now(): string {
  return new Date().toISOString();
}

async function collectFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      result.push(...(await collectFiles(path)));
    } else {
      result.push(path);
    }
  }
  return result;
}

async function computeDigest(skillDir: string): Promise<string> {
  const hash = createHash("sha256");
  const files = (await collectFiles(skillDir)).sort();
  for (const file of files) {
    const rel = relative(skillDir, file);
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) continue;
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(await readFile(file));
    } catch {
      continue;
    }
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

function computeSkillId(name: string, source: string): string {
  return createHash("sha256").update(`${source}:${name}`).digest("hex").slice(0, 20);
}

interface FrontMatterResult {
  payload: Record<string, unknown>;
  errors: string[];
}

async function readFrontMatter(path: string): Promise<FrontMatterResult> {
  const errors: string[] = [];
  let text: string;
  try {
    const info = await stat(path);
    if (info.size > MAX_SKILL_BYTES) {
      return { payload: {}, errors: [`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes`] };
    }
    text = await readFile(path, "utf8");
  } catch (exc) {
    return { payload: {}, errors: [`unable to read SKILL.md: ${exc}`] };
  }
  const match = text.match(FRONT_MATTER);
  if (!match) {
    return { payload: {}, errors: ["SKILL.md must start with YAML front matter"] };
  }
  let payload: unknown;
  try {
    payload = parseYaml(match[1] ?? "");
  } catch (exc) {
    return { payload: {}, errors: [`invalid YAML front matter: ${exc}`] };
  }
  if (payload === null || payload === undefined) {
    return { payload: {}, errors: ["front matter is empty"] };
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { payload: {}, errors: ["front matter must be a YAML mapping"] };
  }
  return { payload: payload as Record<string, unknown>, errors };
}

function normaliseRequirements(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    return [{ name: String(value), kind: "other" }];
  }
  return value.map((item) => {
    if (typeof item === "string") return { name: item, kind: "other" };
    if (item !== null && typeof item === "object") return item as Record<string, unknown>;
    return { name: String(item), kind: "other" };
  });
}

function normaliseThirdParty(value: unknown): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    if (typeof value === "object" && value !== null) return [value as Record<string, unknown>];
    return [{ name: String(value), kind: "other" }];
  }
  return value.map((item) => {
    if (typeof item === "string") return { name: item, kind: "other" };
    if (item !== null && typeof item === "object") return item as Record<string, unknown>;
    return { name: String(item), kind: "other" };
  });
}

function metadataWarnings(metadata: SkillMetadata, payload: Record<string, unknown>, dirName: string, files: SkillFile[]): string[] {
  const warnings: string[] = [];
  const licenseDeclared = typeof payload.license === "string" && payload.license.trim() !== "";
  if (!licenseDeclared) {
    warnings.push('license is not declared in front matter; defaulted to "UNLICENSED"');
  }
  if (metadata.description.length > MAX_DESCRIPTION_BYTES) {
    warnings.push(`description exceeds ${MAX_DESCRIPTION_BYTES} characters; keep the first line short so discovery stays cheap (progressive disclosure)`);
  }
  if (dirName !== metadata.name) {
    warnings.push(`directory name "${dirName}" does not match skill name "${metadata.name}"`);
  }
  for (const field of CLAUDE_ONLY_FIELDS) {
    if (field in payload) warnings.push(`field "${field}" is a Claude Code Agent Skills field and is not honored by pi-science`);
  }
  for (const file of files) {
    if (file.size > MAX_REFERENCE_BYTES) warnings.push(`file ${file.path} exceeds ${MAX_REFERENCE_BYTES} bytes; large files slow seeding and digest computation`);
  }
  if (metadata.third_party.length > 0 && !metadata.third_party.some((item) => item.license)) {
    warnings.push("third_party entries do not declare a license");
  }
  if (
    metadata.risk === "high" &&
    metadata.required_tools.length === 0 &&
    metadata.required_mcp_tools.length === 0
  ) {
    warnings.push("high-risk skills should declare required tools or MCP tools");
  }
  return warnings;
}

async function skillFiles(directory: string, sourceRoot: string): Promise<SkillFile[]> {
  const result: SkillFile[] = [];
  const files = (await collectFiles(directory)).sort();
  for (const file of files) {
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const rel = relative(sourceRoot, file);
    const size = info.size;
    const name = file.split(sep).at(-1) ?? file;
    let kind: SkillFile["kind"] = "other";
    if (name === "SKILL.md") {
      kind = "skill";
    } else if (file.includes(`${sep}reference${sep}`)) {
      kind = "reference";
    } else if (/\.(py|js|ts|sh)$/.test(name)) {
      kind = "helper";
    } else if (["requirements.lock", "requirements.txt", "pyproject.toml", "package.json"].includes(name)) {
      kind = "requirement";
    }
    result.push({ path: rel, kind, size });
  }
  return result;
}

function locationOf(skill: DiscoveredSkill): string {
  const rel = relative(skill.sourceRoot, skill.sourcePath);
  if (rel.startsWith("..") || rel === "") {
    return skill.sourcePath.split(sep).at(-1) ?? skill.sourcePath;
  }
  return rel;
}

export async function parseSkill(path: string, source: string, sourceRoot: string): Promise<DiscoveredSkill> {
  const { payload: rawPayload, errors: readErrors } = await readFrontMatter(path);
  const payload: Record<string, unknown> = { ...rawPayload };
  // Legacy skills often use a bare requirements list; normalisation keeps
  // those skills loadable while making the public contract strict.
  payload.requirements = normaliseRequirements(payload.requirements);
  payload.third_party = normaliseThirdParty(payload.third_party);

  const validationErrors: string[] = [...readErrors];
  const parsed = skillMetadataSchema.safeParse(payload);
  let metadata: SkillMetadata;

  if (parsed.success) {
    metadata = parsed.data;
  } else {
    const rawName = String(payload.name ?? path.split(sep).at(-2) ?? "invalid-skill");
    const fallbackName =
      rawName
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "invalid-skill";
    metadata = skillMetadataSchema.parse({
      name: fallbackName.slice(0, 80),
      description: String(payload.description ?? "Invalid skill metadata"),
    });
    validationErrors.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }

  const files = await skillFiles(dirname(path), sourceRoot);
  if (source === "builtin" && (typeof payload.license !== "string" || payload.license.trim() === "")) {
    validationErrors.push("builtin skills must declare a license in front matter");
  }
  const dirName = dirname(path).split(sep).at(-1) ?? "";
  const validation: SkillValidation = {
    valid: validationErrors.length === 0,
    errors: validationErrors,
    warnings: metadataWarnings(metadata, payload, dirName, files),
    checked_at: now(),
  };

  return {
    sourcePath: path,
    sourceRoot,
    source,
    metadata,
    validation,
    digest: await computeDigest(dirname(path)),
    skillId: computeSkillId(metadata.name, source),
    files,
  };
}

async function scanDir(directory: string, source: string, sourceRoot?: string): Promise<DiscoveredSkill[]> {
  let isDir: boolean;
  try {
    isDir = (await stat(directory)).isDirectory();
  } catch {
    return [];
  }
  if (!isDir) return [];
  const root = sourceRoot ?? directory;
  const result: DiscoveredSkill[] = [];
  const allFiles = (await collectFiles(directory)).sort();
  const skillFiles = allFiles.filter((f) => f.split(sep).at(-1) === "SKILL.md");
  for (const path of skillFiles) {
    try {
      result.push(await parseSkill(path, source, root));
    } catch {
      continue;
    }
  }
  return result;
}

export async function discoverRaw(cwd: string = "."): Promise<DiscoveredSkill[]> {
  const workspace = resolve(cwd);
  const candidates: DiscoveredSkill[] = [];
  // project skills
  candidates.push(...(await scanDir(join(workspace, ".pi", "skills"), "project", workspace)));
  // user skills
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  for (const userDir of [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")]) {
    candidates.push(...(await scanDir(userDir, "user", userDir)));
  }
  // builtin skills
  candidates.push(...(await scanDir(builtinSkillsDir(), "builtin", builtinSkillsDir())));
  return candidates;
}

export async function discover(cwd: string = "."): Promise<DiscoveredSkill[]> {
  const allRecords = await discoverRaw(cwd);
  const grouped = new Map<string, DiscoveredSkill[]>();
  for (const record of allRecords) {
    const list = grouped.get(record.metadata.name) ?? [];
    list.push(record);
    grouped.set(record.metadata.name, list);
  }
  const effective: DiscoveredSkill[] = [];
  for (const records of grouped.values()) {
    records.sort(
      (a, b) =>
        (SOURCE_RANK[a.source] ?? 99) - (SOURCE_RANK[b.source] ?? 99) ||
        a.sourcePath.localeCompare(b.sourcePath),
    );
    effective.push(records[0]!);
  }
  return effective.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

function toSkillInfo(record: DiscoveredSkill, enabled: boolean, shadowed: string[]): SkillInfo {
  let quality: SkillInfo["quality"] = record.validation.valid ? "validated" : "draft";
  const declared = (record.metadata as Record<string, unknown>).quality;
  if (declared === "verified" || declared === "deprecated") {
    quality = declared;
  }
  return {
    skill_id: record.skillId,
    digest: record.digest,
    name: record.metadata.name,
    description: record.metadata.description,
    version: record.metadata.version,
    category: record.metadata.category,
    license: record.metadata.license,
    risk: record.metadata.risk,
    compatibility: typeof record.metadata.compatibility === "string" ? record.metadata.compatibility : record.metadata.compatibility == null ? undefined : JSON.stringify(record.metadata.compatibility),
    quality,
    location: locationOf(record),
    source: record.source as SkillInfo["source"],
    enabled,
    requirements: record.metadata.requirements,
    third_party: record.metadata.third_party,
    entrypoints: record.metadata.entrypoints,
    required_tools: record.metadata.required_tools,
    required_mcp_tools: record.metadata.required_mcp_tools,
    files: record.files,
    validation: record.validation,
    shadowed,
  };
}

export async function catalog(cwd: string = ".", enabledPaths?: Set<string>): Promise<SkillInfo[]> {
  const allRecords = await discoverRaw(cwd);
  const records = await discover(cwd);
  const byName = new Map<string, string[]>();
  for (const record of allRecords) {
    const list = byName.get(record.metadata.name) ?? [];
    list.push(record.source);
    byName.set(record.metadata.name, list);
  }
  return records.map((record) => {
    const enabled = !enabledPaths || enabledPaths.size === 0 || enabledPaths.has(record.sourcePath);
    const shadowed = (byName.get(record.metadata.name) ?? []).slice(1);
    return toSkillInfo(record, enabled, shadowed);
  });
}

export async function getSkillInfo(skillId: string, cwd: string = "."): Promise<SkillInfo | null> {
  const record = await discover(cwd);
  const found = record.find((r) => r.skillId === skillId || r.metadata.name === skillId);
  if (!found) return null;
  return toSkillInfo(found, true, []);
}

export type SkillContentResult =
  | { ok: true; content: SkillContent }
  | { ok: false; error: "not-found" | "unavailable" | "too-large" };

/**
 * Read the effective SKILL.md for a skill (project > user > builtin
 * precedence, matching discovery). The client never supplies a path:
 * the winning discovery record is resolved and contained inside its
 * source root (realpath check) before any read, so a symlink planted in
 * a skills directory cannot leak workspace-external files.
 */
export async function getSkillContent(skillId: string, cwd: string = "."): Promise<SkillContentResult> {
  const record = (await discover(cwd)).find((r) => r.skillId === skillId || r.metadata.name === skillId);
  if (!record) return { ok: false, error: "not-found" };
  // Project skills are managed state under <workspace>/.pi/skills; user and
  // builtin sources treat their scan root as the containment boundary.
  const allowedRoot = record.source === "project" ? join(resolve(cwd), ".pi", "skills") : record.sourceRoot;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(allowedRoot);
  } catch {
    return { ok: false, error: "not-found" };
  }
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(record.sourcePath);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!pathIsInside(canonicalRoot, canonicalPath)) {
    return { ok: false, error: "unavailable" };
  }
  let info;
  try {
    info = await stat(canonicalPath);
  } catch {
    return { ok: false, error: "not-found" };
  }
  if (!info.isFile()) return { ok: false, error: "unavailable" };
  if (info.size > MAX_SKILL_BYTES) return { ok: false, error: "too-large" };
  let content: string;
  try {
    content = await readFile(canonicalPath, "utf8");
  } catch {
    return { ok: false, error: "not-found" };
  }
  return {
    ok: true,
    content: {
      skill_id: record.skillId,
      name: record.metadata.name,
      digest: createHash("sha256").update(content).digest("hex").slice(0, 16),
      source: record.source as SkillContent["source"],
      location: locationOf(record),
      content,
    },
  };
}

export async function validateDirectory(directory: string): Promise<SkillValidation[]> {
  const path = resolve(directory);
  const records = await scanDir(path, "project", path);
  if (records.length === 0) {
    return [{ valid: false, errors: [`no SKILL.md found under ${path}`], warnings: [], checked_at: now() }];
  }
  return records.map((r) => r.validation);
}
