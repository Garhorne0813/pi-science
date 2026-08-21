import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";
import { configPath, readJson, withFileWriteLock, withWorkspaceWriteLock, writeJsonAtomic } from "../../storage/persistence.js";

export type EnvironmentLanguage = "python" | "r";
export type EnvironmentStatus = "creating" | "ready" | "failed" | "archived";

export interface EnvironmentRevision {
  environment_id: string;
  revision_id: string;
  name: string;
  display_name: string;
  language: EnvironmentLanguage;
  status: EnvironmentStatus;
  prefix: string;
  packages: string[];
  platform: string;
  created_at: string;
  supersedes_revision_id?: string;
  /** Sorted conda-meta manifests plus site-packages dist-info / R library entries; detects out-of-band prefix mutation (e.g. direct pip install). */
  integrity_snapshot?: string[];
  failure?: { stage: string; message: string };
}

interface EnvironmentRegistry { schema_version: 1; revisions: EnvironmentRevision[] }
interface ProjectEnvironmentBinding { schema_version: 1; environment_id: string; revision_id: string; bound_at: string }

export interface WorkspaceEnvironmentStatus {
  ready: boolean;
  workspace: string;
  prefix: string;
  python: string;
  pip: string;
  r?: string;
  environment_id?: string;
  revision_id?: string;
  display_name?: string;
  manager?: "micromamba" | "legacy-venv";
  legacy?: boolean;
  npm: { local_prefix: string; global_prefix: string; cache: string };
  error?: string;
}

export interface NodeWorkspaceStatus {
  workspace: string;
  node_version: string | null;
  package_managers: { npm: boolean; pnpm: boolean; yarn: boolean; bun: boolean };
  lockfile: { exists: boolean; name: string | null };
  node_modules_exists: boolean;
  install_needed: boolean;
  tooling: {
    npm_prefix: string;
    npm_cache: string;
    pnpm_home: string;
    corepack_home: string;
    npm_prefix_size: number | null;
    npm_cache_size: number | null;
    pnpm_home_size: number | null;
    corepack_home_size: number | null;
  };
}

export interface CreateEnvironmentInput {
  name: string;
  display_name?: string;
  language?: EnvironmentLanguage;
  packages?: string[];
  preset?: EnvironmentPresetId;
  supersedes_revision_id?: string;
}

export interface EnvironmentPreset {
  id: EnvironmentPresetId;
  name: string;
  language: EnvironmentLanguage;
  packages: string[];
}

const DEFAULT_ENVIRONMENT_ID = "env_python_standard";
const DEFAULT_PACKAGES = ["python=3.12", "pip"];
const DEFAULT_R_PACKAGES = ["r-base=4.4"];

export const ENVIRONMENT_PRESETS = {
  "python-minimal": { name: "Python Minimal", language: "python", packages: ["python=3.12", "pip"] },
  "python-data": { name: "Python Data", language: "python", packages: ["python=3.12", "pip", "numpy", "pandas", "matplotlib"] },
  "python-science": { name: "Python Science", language: "python", packages: ["python=3.12", "pip", "numpy", "pandas", "scipy", "matplotlib"] },
  "r-minimal": { name: "R Minimal", language: "r", packages: ["r-base=4.4"] },
} as const;

export type EnvironmentPresetId = keyof typeof ENVIRONMENT_PRESETS;

const MICROMAMBA_VERSION = "2.5.0-2";
const MICROMAMBA_SHA256: Record<string, string> = {
  "linux-64": "c04571cfb0750e5432d530a3068b8fcd232ebed3133358e056e59a90b9852b00",
  "linux-aarch64": "a64db0d7a82107c8d64357cf035fb8f9dbbe2fc48f48b302cbc8ba1590974e20",
  "osx-arm64": "22953898e3cfd63c680d696a204c7858ce7f10a10c271bda7e6defd63370ee41",
  "osx-64": "d6542ddf80e0b81b8538f811dd64ad5804373206bc0128cbc4a8833efe67547b",
};

function environmentPaths(prefix: string, platform = process.platform) {
  const bin = platform === "win32" ? join(prefix, "Scripts") : join(prefix, "bin");
  return { virtualEnv: prefix, bin, python: join(bin, platform === "win32" ? "python.exe" : "python"), pip: join(bin, platform === "win32" ? "pip.exe" : "pip") };
}

function environmentExecutable(prefix: string, language: EnvironmentLanguage, platform = process.platform): string {
  const paths = environmentPaths(prefix, platform);
  return language === "r" ? join(paths.bin, platform === "win32" ? "Rscript.exe" : "Rscript") : paths.python;
}

function nodeToolsRoot(workspace: string): string {
  return join(workspace, ".pi-science", "node-tools");
}

function npmGlobalPrefixFor(workspace: string): string {
  return join(nodeToolsRoot(workspace), "npm");
}

function pnpmHomeFor(workspace: string): string {
  return join(nodeToolsRoot(workspace), "pnpm");
}

function corepackHomeFor(workspace: string): string {
  return join(workspace, ".pi-science", "cache", "corepack");
}

function commandAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return result.error === undefined && result.status !== null;
  } catch {
    return false;
  }
}

async function dirSize(target: string): Promise<number | null> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return null;
    let total = 0;
    const stack = [target];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        try {
          const entryInfo = await stat(full);
          if (entryInfo.isDirectory()) stack.push(full);
          else total += entryInfo.size;
        } catch { /* skip unreadable entries */ }
      }
    }
    return total;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true; } catch { return false; } }

/** Content fingerprint of a conda prefix built from directory listings only (no subprocesses).
 * pip installs add dist-info directories without touching conda-meta, so both are captured. */
async function integritySnapshot(prefix: string): Promise<string[]> {
  const parts: string[] = [];
  try { parts.push(...(await readdir(join(prefix, "conda-meta"))).filter((name) => name.endsWith(".json")).sort()); } catch { /* not a conda prefix */ }
  try {
    const libDir = process.platform === "win32" ? join(prefix, "Lib") : join(prefix, "lib");
    const pythonLib = (await readdir(libDir)).find((name) => /^python3\.\d+$/.test(name));
    if (pythonLib) parts.push(...(await readdir(join(libDir, pythonLib, "site-packages"))).filter((name) => name.endsWith(".dist-info")).sort());
  } catch { /* no Python site-packages */ }
  try { parts.push(...(await readdir(join(prefix, "library"))).sort()); } catch { /* no R library */ }
  return parts;
}

function snapshotDriftError(revisionId: string): string {
  return `Environment revision ${revisionId} was modified outside Pi-Science (for example by a direct pip install into the shared prefix). Roll back or create a new revision via the packages API instead of mutating the prefix.`;
}
function bindingPath(cwd: string): string { return join(resolve(cwd), ".pi-science", "environment.json"); }
function registryPath(): string { return configPath(join("environments", "registry.json")); }
function environmentRoot(): string { return configPath(join("micromamba", "envs")); }

function isInheritedRuntimeState(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized === "VIRTUAL_ENV"
    || normalized === "UV_PROJECT_ENVIRONMENT"
    || normalized === "PIP_REQUIRE_VIRTUALENV"
    || normalized === "PI_SCIENCE_PYTHON_EXECUTABLE"
    || normalized === "PYTHONHOME"
    || normalized === "PIP_PREFIX"
    || normalized === "CONDA_DEFAULT_ENV"
    || normalized === "CONDA_EXE"
    || normalized === "CONDA_PYTHON_EXE"
    || normalized === "CONDA_SHLVL"
    || normalized === "CONDA_PROMPT_MODIFIER"
    || normalized === "CONDARC"
    || normalized === "CONDA_CHANNELS"
    || normalized === "CONDA_DEFAULT_CHANNELS"
    || normalized === "CONDA_SUBDIR"
    || normalized === "CONDA_PKGS_DIRS"
    || normalized === "CONDA_BLD_PATH"
    || normalized === "MAMBA_ROOT_PREFIX"
    || normalized === "MAMBA_EXE"
    || normalized === "MAMBA_NO_RC"
    || normalized === "MAMBARC"
    || /^CONDA_PREFIX(?:_\d+)?$/.test(normalized);
}

function safeName(value: string): string {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name || name.length > 64) throw new Error("Environment name must contain 1-64 letters, digits, dots, dashes, or underscores");
  return name;
}

export function defaultPythonExecutable(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return environment.PYTHON || (platform === "win32" ? "python" : "python3");
}

export function workspaceEnvironmentVariables(status: WorkspaceEnvironmentStatus, inherited: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const paths = environmentPaths(status.prefix, platform);
  const npmGlobal = status.npm.global_prefix;
  const npmBin = platform === "win32" ? npmGlobal : join(npmGlobal, "bin");
  const pnpmHome = pnpmHomeFor(status.workspace);
  const corepackHome = corepackHomeFor(status.workspace);
  const inheritedPath = platform === "win32" ? Object.entries(inherited).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "" : inherited.PATH ?? "";
  const base = Object.fromEntries(Object.entries(inherited).filter(([key]) => key.toLowerCase() !== "path" && !isInheritedRuntimeState(key)));
  return {
    ...base,
    PATH: [paths.bin, npmBin, pnpmHome, inheritedPath].filter(Boolean).join(platform === "win32" ? ";" : delimiter),
    CONDA_PREFIX: status.manager === "micromamba" ? status.prefix : undefined,
    PI_SCIENCE_ENVIRONMENT_ID: status.environment_id,
    PI_SCIENCE_ENVIRONMENT_REVISION_ID: status.revision_id,
    PI_SCIENCE_ENVIRONMENT_PREFIX: status.prefix,
    PYTHONNOUSERSITE: "1", PIP_USER: "0",
    npm_config_prefix: npmGlobal, NPM_CONFIG_PREFIX: npmGlobal,
    npm_config_cache: status.npm.cache, NPM_CONFIG_CACHE: status.npm.cache, npm_config_update_notifier: "false",
    PNPM_HOME: pnpmHome, COREPACK_HOME: corepackHome,
    PYTHONHOME: undefined, PIP_PREFIX: undefined,
  };
}

export class WorkspaceEnvironmentService {
  private readonly provisioning = new Map<string, Promise<WorkspaceEnvironmentStatus>>();
  private readonly creating = new Map<string, Promise<EnvironmentRevision>>();

  constructor(
    private readonly basePython = defaultPythonExecutable(),
    private readonly micromambaExecutable = process.env.PI_SCIENCE_MICROMAMBA_EXECUTABLE || "micromamba",
  ) {}

  async list(): Promise<EnvironmentRevision[]> {
    return (await this.registry()).revisions.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  listPresets(): EnvironmentPreset[] {
    return (Object.keys(ENVIRONMENT_PRESETS) as EnvironmentPresetId[]).map((id) => ({
      id,
      name: ENVIRONMENT_PRESETS[id].name,
      language: ENVIRONMENT_PRESETS[id].language,
      packages: [...ENVIRONMENT_PRESETS[id].packages],
    }));
  }


  async binding(cwdValue: string): Promise<ProjectEnvironmentBinding | null> {
    const value = await readJson<unknown>(bindingPath(cwdValue), null);
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    return row.schema_version === 1 && typeof row.environment_id === "string" && typeof row.revision_id === "string" && typeof row.bound_at === "string" ? row as unknown as ProjectEnvironmentBinding : null;
  }

  async bind(cwdValue: string, revisionId: string): Promise<WorkspaceEnvironmentStatus> {
    const cwd = resolve(cwdValue);
    const revision = (await this.list()).find((item) => item.revision_id === revisionId && item.status === "ready");
    if (!revision) throw new Error(`Ready environment revision not found: ${revisionId}`);
    await this.verifyRevisionIntegrity(revision);
    return withWorkspaceWriteLock(cwd, () => this.bindUnlocked(cwd, revision));
  }

  async status(cwdValue: string): Promise<WorkspaceEnvironmentStatus> {
    const workspace = resolve(cwdValue);
    const binding = await this.binding(workspace);
    if (binding) {
      const revision = (await this.list()).find((item) => item.revision_id === binding.revision_id);
      if (!revision) return this.statusFor(workspace, environmentRoot(), "micromamba", { error: `Bound environment revision is missing: ${binding.revision_id}` });
      const runtimeExecutable = environmentExecutable(revision.prefix, revision.language);
      let driftError: string | undefined;
      if (revision.status === "ready" && revision.integrity_snapshot && await executable(runtimeExecutable)) {
        const current = await integritySnapshot(revision.prefix);
        if (current.join("\n") !== revision.integrity_snapshot.join("\n")) driftError = snapshotDriftError(revision.revision_id);
      }
      const ready = revision.status === "ready" && !driftError && await executable(runtimeExecutable);
      return this.statusFor(workspace, revision.prefix, "micromamba", { ready, environment_id: revision.environment_id, revision_id: revision.revision_id, display_name: revision.display_name, ...(!ready ? { error: driftError ?? revision.failure?.message ?? (revision.status === "ready" ? `Environment executable is missing: ${runtimeExecutable}` : `Environment is ${revision.status}`) } : {}) });
    }
    const legacy = environmentPaths(join(workspace, ".venv"));
    if (await exists(join(legacy.virtualEnv, "pyvenv.cfg")) && await executable(legacy.python)) return this.statusFor(workspace, legacy.virtualEnv, "legacy-venv", { ready: true, legacy: true });
    if (await exists(legacy.virtualEnv)) {
      const info = await stat(legacy.virtualEnv);
      return this.statusFor(workspace, legacy.virtualEnv, "legacy-venv", { error: info.isDirectory() ? "The workspace .venv is incomplete. Remove or repair it before migration." : "The workspace .venv path exists but is not a directory." });
    }
    return this.statusFor(workspace, environmentRoot(), "micromamba", { ready: false });
  }

  async ensure(cwdValue: string): Promise<WorkspaceEnvironmentStatus> {
    const cwd = resolve(cwdValue);
    const current = this.provisioning.get(cwd);
    if (current) return current;
    const operation = this.provision(cwd).finally(() => this.provisioning.delete(cwd));
    this.provisioning.set(cwd, operation);
    return operation;
  }

  async nodeStatus(cwdValue: string): Promise<NodeWorkspaceStatus> {
    const workspace = resolve(cwdValue);
    const packageJson = join(workspace, "package.json");
    const packageJsonExists = await exists(packageJson);
    const lockfileCandidates = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
    let lockfile: { exists: boolean; name: string | null } = { exists: false, name: null };
    for (const name of lockfileCandidates) {
      if (await exists(join(workspace, name))) {
        lockfile = { exists: true, name };
        break;
      }
    }
    const nodeModules = join(workspace, "node_modules");
    const nodeModulesExists = await exists(nodeModules);
    const npmPrefix = npmGlobalPrefixFor(workspace);
    const npmCache = join(workspace, ".pi-science", "cache", "npm");
    const pnpmHome = pnpmHomeFor(workspace);
    const corepackHome = corepackHomeFor(workspace);
    const [npmPrefixSize, npmCacheSize, pnpmHomeSize, corepackHomeSize] = await Promise.all([
      dirSize(npmPrefix), dirSize(npmCache), dirSize(pnpmHome), dirSize(corepackHome),
    ]);
    return {
      workspace,
      node_version: process.versions.node ?? null,
      package_managers: {
        npm: commandAvailable("npm"),
        pnpm: commandAvailable("pnpm"),
        yarn: commandAvailable("yarn"),
        bun: commandAvailable("bun"),
      },
      lockfile,
      node_modules_exists: nodeModulesExists,
      install_needed: packageJsonExists && !nodeModulesExists,
      tooling: {
        npm_prefix: npmPrefix,
        npm_cache: npmCache,
        pnpm_home: pnpmHome,
        corepack_home: corepackHome,
        npm_prefix_size: npmPrefixSize,
        npm_cache_size: npmCacheSize,
        pnpm_home_size: pnpmHomeSize,
        corepack_home_size: corepackHomeSize,
      },
    };
  }


  async environment(cwdValue: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    return workspaceEnvironmentVariables(await this.ensure(cwdValue), inherited);
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentRevision> {
    const name = safeName(input.name);
    const preset = input.preset ? ENVIRONMENT_PRESETS[input.preset] : undefined;
    if (preset && input.language && input.language !== preset.language) {
      throw new Error(`Preset ${input.preset} is for ${preset.language} environments`);
    }
    const language = input.language ?? preset?.language ?? "python";
    const packages = [...new Set((input.packages?.length ? input.packages : preset?.packages ?? (language === "r" ? DEFAULT_R_PACKAGES : DEFAULT_PACKAGES)).map((item) => item.trim()).filter(Boolean))];
    const previous = input.supersedes_revision_id ? (await this.list()).find((item) => item.revision_id === input.supersedes_revision_id) : undefined;
    if (input.supersedes_revision_id && !previous) throw new Error(`Environment revision not found: ${input.supersedes_revision_id}`);
    const key = `${previous?.environment_id ?? name}\0${packages.join("\0")}`;
    const current = this.creating.get(key);
    if (current) return current;
    const operation = this.createRevision({ environment_id: previous?.environment_id ?? `env_${name}_${randomUUID().slice(0, 8)}`, name, display_name: input.display_name?.trim() || name, language, packages, ...(previous ? { supersedes_revision_id: previous.revision_id } : {}) }).finally(() => this.creating.delete(key));
    this.creating.set(key, operation);
    return operation;
  }
/** Install packages into the currently bound revision by creating a new immutable revision. */
  async installPackages(cwdValue: string, packages: string[]): Promise<WorkspaceEnvironmentStatus> {
    const cwd = resolve(cwdValue);
    return withWorkspaceWriteLock(cwd, async () => {
      const currentStatus = await this.status(cwd);
      if (!currentStatus.revision_id || !currentStatus.environment_id) {
        throw new Error("Workspace has no bound environment revision; create or bind one first");
      }
      const current = (await this.list()).find((item) => item.revision_id === currentStatus.revision_id);
      if (!current) {
        throw new Error(`Bound environment revision not found: ${currentStatus.revision_id}`);
      }
      if (current.status !== "ready") {
        throw new Error(`Bound environment revision is not ready: ${current.status}`);
      }
      const normalized = [...new Set(packages.map((item) => item.trim()).filter(Boolean))];
      if (normalized.length === 0) {
        throw new Error("No packages requested");
      }
      const missing = normalized.filter((packageSpec) => !current.packages.includes(packageSpec));
      if (missing.length === 0) return currentStatus;
      const combined = [...new Set([...current.packages, ...missing])];
      const revision = await this.create({
        name: current.name,
        display_name: current.display_name,
        language: current.language,
        packages: combined,
        supersedes_revision_id: current.revision_id,
      });
      return this.bindUnlocked(cwd, revision);
    });
  }


/** Promote a staging (creating) revision to ready after its health check passes. */
  async promote(revisionId: string): Promise<EnvironmentRevision> {
    const revision = (await this.list()).find((item) => item.revision_id === revisionId);
    if (!revision) throw new Error(`Environment revision not found: ${revisionId}`);
    if (revision.status !== "creating") throw new Error(`Only creating revisions can be promoted: ${revision.status}`);
    await this.runHealthCheck(revision.prefix, revision.language);
    const promoted: EnvironmentRevision = { ...revision, status: "ready" };
    await this.upsert(promoted);
    return promoted;
  }

/** Roll the workspace back to the previous ready revision in the chain. */
  async rollback(cwdValue: string): Promise<WorkspaceEnvironmentStatus> {
    const cwd = resolve(cwdValue);
    const current = await this.status(cwd);
    if (!current.revision_id) throw new Error("Workspace has no bound environment revision");
    const currentRevision = (await this.list()).find((item) => item.revision_id === current.revision_id);
    if (!currentRevision?.supersedes_revision_id) throw new Error("No previous revision to roll back to");
    const previous = (await this.list()).find((item) => item.revision_id === currentRevision.supersedes_revision_id && item.status === "ready");
    if (!previous) throw new Error(`Previous ready revision not found: ${currentRevision.supersedes_revision_id}`);
    return this.bind(cwd, previous.revision_id);
  }

  private async provision(cwd: string): Promise<WorkspaceEnvironmentStatus> {
    const before = await this.status(cwd);
    if (before.ready) return before;
    if (before.error) throw new Error(before.error);
    if (process.env.NODE_ENV === "test") {
      const legacy = join(cwd, ".venv");
      await this.run(this.basePython, ["-m", "venv", legacy], 120_000);
      return this.status(cwd);
    }
    const existing = (await this.list()).find((item) => item.environment_id === DEFAULT_ENVIRONMENT_ID && item.status === "ready");
    const revision = existing ?? await this.createRevision({ environment_id: DEFAULT_ENVIRONMENT_ID, name: "python-standard", display_name: "Python Standard", language: "python", packages: DEFAULT_PACKAGES });
    return this.bind(cwd, revision.revision_id);
  }

  private async createRevision(input: Omit<EnvironmentRevision, "revision_id" | "status" | "prefix" | "platform" | "created_at">): Promise<EnvironmentRevision> {
    const revisionId = `rev_${randomUUID().replaceAll("-", "")}`;
    const finalPrefix = join(environmentRoot(), revisionId);
    let revision: EnvironmentRevision = { ...input, revision_id: revisionId, status: "creating", prefix: finalPrefix, platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString() };
    await this.upsert(revision);
    await rm(finalPrefix, { recursive: true, force: true });
    try {
      await mkdir(environmentRoot(), { recursive: true });
      const micromamba = await this.ensureMicromamba();
      // Conda prefixes are not safely relocatable: create at the final path and
      // use registry status as the publication boundary. Failed prefixes are
      // removed before the revision is marked failed.
      await this.run(micromamba, ["create", "--yes", "--prefix", finalPrefix, "--channel", "conda-forge", "--strict-channel-priority", ...input.packages], 20 * 60_000, this.micromambaEnvironment());
      await this.runHealthCheck(finalPrefix, input.language);
      revision = { ...revision, status: "ready", integrity_snapshot: await integritySnapshot(finalPrefix) };
      await this.upsert(revision);
      return revision;
    } catch (error) {
      await rm(finalPrefix, { recursive: true, force: true });
      revision = { ...revision, status: "failed", failure: { stage: "create", message: error instanceof Error ? error.message : String(error) } };
      await this.upsert(revision);
      throw error;
    }
  }

  private async runHealthCheck(prefix: string, language: EnvironmentLanguage): Promise<void> {
    if (language === "r") {
      const rscript = join(environmentPaths(prefix).bin, process.platform === "win32" ? "Rscript.exe" : "Rscript");
      if (!await executable(rscript)) throw new Error("Environment health check failed: Rscript is missing");
      await this.run(rscript, ["-e", "cat(R.version.string)"], 30_000, this.micromambaEnvironment());
    } else {
      const python = environmentPaths(prefix).python;
      if (!await executable(python)) throw new Error("Environment health check failed: Python executable is missing");
      await this.run(python, ["-c", "import sys; print(sys.version_info[:2])"], 30_000, this.micromambaEnvironment());
    }
  }

  /** Hard gate for attaching a revision to a workspace. Legacy records without a snapshot are
   * backfilled instead of failing so existing installations migrate lazily. */
  private async verifyRevisionIntegrity(revision: EnvironmentRevision): Promise<void> {
    if (revision.status !== "ready") return;
    const current = await integritySnapshot(revision.prefix);
    if (!revision.integrity_snapshot) {
      await this.upsert({ ...revision, integrity_snapshot: current });
      return;
    }
    if (current.join("\n") !== revision.integrity_snapshot.join("\n")) throw new Error(snapshotDriftError(revision.revision_id));
  }

  private async registry(): Promise<EnvironmentRegistry> {
    const value = await readJson<EnvironmentRegistry>(registryPath(), { schema_version: 1, revisions: [] });
    return value.schema_version === 1 && Array.isArray(value.revisions) ? value : { schema_version: 1, revisions: [] };
  }

  private async upsert(revision: EnvironmentRevision): Promise<void> {
    const path = registryPath();
    await withFileWriteLock(path, async () => {
      const registry = await this.registry();
      await writeJsonAtomic(path, { schema_version: 1, revisions: [...registry.revisions.filter((item) => item.revision_id !== revision.revision_id), revision] } satisfies EnvironmentRegistry);
    });
  }

  private statusFor(workspace: string, prefix: string, manager: NonNullable<WorkspaceEnvironmentStatus["manager"]>, extra: Partial<WorkspaceEnvironmentStatus>): WorkspaceEnvironmentStatus {
    const paths = environmentPaths(prefix);
    return { ready: false, workspace, prefix: prefix, python: paths.python, pip: paths.pip, r: environmentExecutable(prefix, "r"), manager, npm: { local_prefix: workspace, global_prefix: npmGlobalPrefixFor(workspace), cache: join(workspace, ".pi-science", "cache", "npm") }, ...extra };
  }

  private async ensureMicromamba(): Promise<string> {
    if (this.micromambaExecutable !== "micromamba") return this.micromambaExecutable;
    try { await this.run("micromamba", ["--version"], 10_000, this.micromambaEnvironment()); return "micromamba"; } catch { /* install pinned binary */ }
    const platform = process.platform === "darwin"
      ? process.arch === "arm64" ? "osx-arm64" : "osx-64"
      : process.platform === "linux" ? process.arch === "arm64" ? "linux-aarch64" : "linux-64" : null;
    if (!platform || !MICROMAMBA_SHA256[platform]) throw new Error(`Micromamba auto-install is unsupported on ${process.platform}-${process.arch}`);
    const target = configPath(join("micromamba", "bin", process.platform === "win32" ? "micromamba.exe" : "micromamba"));
    if (await executable(target)) return target;
    const lock = `${target}.install`;
    return withFileWriteLock(lock, async () => {
      if (await executable(target)) return target;
      const url = `https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}/micromamba-${platform}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Micromamba download failed: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== MICROMAMBA_SHA256[platform]) throw new Error(`Micromamba SHA-256 mismatch: expected ${MICROMAMBA_SHA256[platform]}, got ${actual}`);
      await mkdir(join(configPath("micromamba"), "bin"), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, data);
      await chmod(temporary, 0o755);
      await rename(temporary, target);
      return target;
    });
  }

  private async bindUnlocked(cwd: string, revision: EnvironmentRevision): Promise<WorkspaceEnvironmentStatus> {
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const path = bindingPath(cwd);
    await writeJsonAtomic(path, { schema_version: 1, environment_id: revision.environment_id, revision_id: revision.revision_id, bound_at: new Date().toISOString() } satisfies ProjectEnvironmentBinding);
    return this.status(cwd);
  }

  private micromambaEnvironment(): NodeJS.ProcessEnv {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !isInheritedRuntimeState(key)));
    environment.MAMBA_ROOT_PREFIX = configPath("micromamba");
    environment.MAMBA_NO_RC = "true";
    return environment;
  }

  private async run(command: string, args: string[], timeout: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL" });
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      child.once("error", reject); child.once("close", (code) => done({ code, output: Buffer.concat(output).toString("utf8") }));
    });
    if (result.code !== 0) throw new Error(`${command} failed: ${result.output || `exit ${result.code}`}`);
  }
}
