import { access, cp, lstat, mkdir, readdir, readFile, realpath, rename, stat, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { configPath, readJson, withFileWriteLock, writeJsonAtomic } from "../../storage/persistence.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { probeMcpHealth, type McpDefinition } from "../../security/mcp-health.js";
import { egressAuditEnabled, recordEgress } from "../../security/egress-audit.js";
import { sessionRepository } from "../../runtime/node/session-repository.js";
import { catalog as skillCatalog, getSkillContent, getSkillInfo, validateDirectory as validateSkillDir } from "../../catalog/skill-catalog.js";
import { probeRequirements } from "../../catalog/skill-requirements.js";
import type { JobCoordinator } from "../../runtime/jobs/job-coordinator.js";
import type { ResearchLoopCoordinator } from "../../research-loop/coordinator.js";
import type { RemoteJobCoordinator } from "../../runtime/remote/remote-job.js";
import { findExecutable, pathIsInside, userHome } from "../../support/platform-utils.js";
import { defaultPythonExecutable } from "../../runtime/workspace/workspace-environment.js";
import { ensureProject, updateProject } from "../../project/project-registry.js";

function q(request: { query: unknown }, key: string, fallback = "."): string { const value = (request.query as Record<string, unknown>)[key]; return typeof value === "string" && value ? value : fallback; }
async function ws(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> { try { return await validateWorkspaceCwd(q(request, "cwd")); } catch (error) { reply.code(403).send({ error: String(error) }); return null; } }
function rootDir(): string { return resolve(process.env.PI_SCIENCE_WORKSPACES ?? join(userHome(), "pi-science-workspaces")); }
const REGISTERED_WORKSPACES_FILE = "registered-workspaces.json";

async function rememberExternalWorkspace(path: string): Promise<void> {
  const canonicalPath = await realpath(path);
  const managedRoot = await realpath(rootDir()).catch(() => rootDir());
  if (pathIsInside(managedRoot, canonicalPath, true)) return;
  const registryPath = configPath(REGISTERED_WORKSPACES_FILE);
  await withFileWriteLock(registryPath, async () => {
    const registered = await readJson<string[]>(registryPath, []);
    const paths = [...new Set([...registered.map((value) => resolve(value)), canonicalPath])];
    await writeJsonAtomic(registryPath, paths);
  });
}

export async function knownWorkspacePaths(): Promise<string[]> {
  const paths = new Set<string>();
  try {
    for (const name of await readdir(rootDir())) {
      const path = join(rootDir(), name);
      try { if ((await stat(join(path, ".pi-science"))).isDirectory()) paths.add(path); } catch { /* skip */ }
    }
  } catch { /* workspace root absent */ }
  const [registered, pinned] = await Promise.all([
    readJson<string[]>(configPath(REGISTERED_WORKSPACES_FILE), []),
    readJson<string[]>(configPath("pinned.json"), []),
  ]);
  for (const value of [...registered, ...pinned]) {
    const path = resolve(value);
    try { if ((await stat(join(path, ".pi-science"))).isDirectory()) paths.add(path); } catch { /* stale pin */ }
  }
  return [...paths];
}
async function workspaceInfo(path: string): Promise<Record<string, unknown>> {
  const project = await ensureProject(path);
  const [sessions, metadata] = await Promise.all([sessionRepository.list(path), stat(path)]);
  return {
    name: project.name,
    path,
    project_id: project.id,
    session_count: sessions.length,
    last_modified: metadata.mtime.toISOString(),
  };
}
export function expandUserPath(path: string): string { if (path === "~") return resolve(userHome()); return path.startsWith("~/") || path.startsWith("~\\") ? resolve(userHome(), path.slice(2)) : resolve(path); }
async function managedWorkspacePath(pathValue: string, action: "delete" | "rename"): Promise<string> {
  const configuredRoot = rootDir();
  const requested = resolve(pathValue);
  if (!pathIsInside(configuredRoot, requested)) throw new Error(`Cannot ${action} outside workspaces directory`);
  const canonicalRoot = await realpath(configuredRoot);
  let current = configuredRoot;
  for (const part of relative(configuredRoot, requested).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Cannot ${action} a workspace through a symlink or junction`);
  }
  const canonicalRequested = await realpath(requested);
  if (!pathIsInside(canonicalRoot, canonicalRequested)) throw new Error(`Cannot ${action} outside workspaces directory`);
  const workspaceParts = relative(canonicalRoot, canonicalRequested).split(sep).filter(Boolean);
  if (workspaceParts.length !== 1) throw new Error(`Cannot ${action} a nested workspace path`);
  let marker;
  try { marker = await stat(join(canonicalRequested, ".pi-science")); }
  catch { throw new Error(`Cannot ${action} a directory that is not a workspace`); }
  if (!marker.isDirectory()) throw new Error(`Cannot ${action} a directory that is not a workspace`);
  return canonicalRequested;
}

async function updatePinnedWorkspace(source: string, destination: string): Promise<void> {
  const pinned = await readJson<string[]>(configPath("pinned.json"), []);
  let changed = false;
  const updated = await Promise.all(pinned.map(async (path) => {
    const requested = resolve(path);
    const canonical = await realpath(requested).catch(async () => join(await realpath(dirname(requested)).catch(() => dirname(requested)), basename(requested)));
    if (canonical !== source) return path;
    changed = true;
    return destination;
  }));
  if (changed) await writeJsonAtomic(configPath("pinned.json"), updated);
}
export function catalogToolCommands(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): ReadonlyArray<readonly [string, string]> {
  return [["python", defaultPythonExecutable(environment, platform)], ["Node.js", "node"], ["Git", "git"], ["uv", "uv"]];
}

type ComputeProbeInput = {
  host: string;
  user?: string;
  port?: number;
  auth_method?: "key" | "password";
  identity_file?: string;
  password?: string;
};

const REMOTE_PROBE_COMMAND = [
  'printf "hostname="; hostname',
  'printf "os="; uname -srm',
  'printf "cores="; (getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)',
  'printf "memory_bytes="; (awk \'/MemTotal/ { print $2 * 1024 }\' /proc/meminfo 2>/dev/null || sysctl -n hw.memsize 2>/dev/null || echo 0)',
  'printf "gpus="; (command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l | tr -d " " || echo 0)',
  'printf "has_slurm="; (command -v sbatch >/dev/null 2>&1 && echo yes || echo no)',
].join("; ");

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

async function probeComputeMachine(input: ComputeProbeInput): Promise<Record<string, unknown>> {
  const host = String(input.host ?? "").trim();
  const user = String(input.user ?? "").trim();
  const port = Number(input.port ?? 22);
  if (!host || host.startsWith("-") || !/^[a-zA-Z0-9._:[\]-]+$/.test(host)) return { reachable: false, error: "Invalid SSH hostname" };
  if (user && !/^[a-zA-Z0-9._-]+$/.test(user)) return { reachable: false, error: "Invalid SSH username" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { reachable: false, error: "SSH port must be between 1 and 65535" };

  const authMethod = input.auth_method === "password" ? "password" : "key";
  const identityFile = String(input.identity_file ?? "~/.ssh/id_rsa").trim();
  const sshArgs = [
    "-o", "ConnectTimeout=8",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=1",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(port),
  ];
  let command = "ssh";
  let args = sshArgs;
  const environment = { ...process.env };
  if (authMethod === "password") {
    if (!input.password) return { reachable: false, error: "Password is required for this probe" };
    command = "sshpass";
    environment.SSHPASS = String(input.password);
    args = ["-e", "ssh", ...sshArgs, "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no"];
  } else {
    const keyPath = expandUserPath(identityFile || "~/.ssh/id_rsa");
    try { await access(keyPath); }
    catch { return { reachable: false, error: `SSH key not found: ${identityFile || "~/.ssh/id_rsa"}` }; }
    args = [...sshArgs, "-o", "BatchMode=yes", "-i", keyPath];
  }
  args.push(user ? `${user}@${host}` : host, REMOTE_PROBE_COMMAND);

  return await new Promise((resolveProbe) => {
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    child.stdout.on("data", (chunk) => { if (stdout.length < 65_536) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += String(chunk); });
    child.on("error", (error) => finish({ reachable: false, error: command === "sshpass" && (error as NodeJS.ErrnoException).code === "ENOENT" ? "Password authentication requires sshpass to be installed" : String(error.message) }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ reachable: false, error: stderr.trim() || `SSH exited with code ${code}` });
      const values = Object.fromEntries(stdout.split(/\r?\n/).map((line) => line.split("=")).filter((parts) => parts.length >= 2).map(([key, ...rest]) => [key, rest.join("=").trim()]));
      finish({
        reachable: true,
        hostname: values.hostname || host,
        os: values.os || "unknown",
        cores: Number(values.cores ?? 0),
        memory: formatBytes(Number(values.memory_bytes ?? 0)),
        gpus: Number(values.gpus ?? 0),
        has_slurm: values.has_slurm === "yes",
      });
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ reachable: false, error: "SSH connection timed out" });
    }, 12_000);
  });
}

// src/ (or dist/) -> apps/server/ -> apps/ -> project root, where the shipped demo assets live.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
/** The two demo cards the projects page offers; the request name is an allowlist key, never a path. */
const DEMOS: Record<string, { source: string; workspace: string }> = {
  molecules: { source: "demos/molecular-playground", workspace: "Molecular Playground" },
  climate: { source: "demos/climate-trends", workspace: "Climate Trends" },
};

export function registerCatalogRoutes(app: FastifyInstance, jobs?: JobCoordinator, research?: ResearchLoopCoordinator, remoteJobs?: RemoteJobCoordinator): void {
  // ── Skills (delegated to skill-catalog service) ──
  app.get("/api/skills", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    return skillCatalog(root);
  });
  app.get<{ Params: { skill_id: string } }>("/api/skills/:skill_id", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const item = await getSkillInfo(request.params.skill_id, root);
    return item ?? reply.code(404).send({ error: "Skill not found" });
  });
  app.get<{ Params: { skill_id: string } }>("/api/skills/:skill_id/readiness", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const item = await getSkillInfo(request.params.skill_id, root);
    if (!item) return reply.code(404).send({ error: "Skill not found" });
    return probeRequirements(item.skill_id, item.requirements);
  });
  // Read-only preview of the effective SKILL.md (project > user > builtin).
  // The path is never client-supplied: the winning discovery record is
  // resolved with realpath containment inside its source root.
  app.get<{ Params: { skill_id: string } }>("/api/skills/:skill_id/content", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const result = await getSkillContent(request.params.skill_id, root);
    if (!result.ok) {
      if (result.error === "not-found") return reply.code(404).send({ error: "Skill not found" });
      if (result.error === "unavailable") return reply.code(403).send({ error: "Skill content unavailable" });
      return reply.code(413).send({ error: "Skill content exceeds the size limit" });
    }
    return result.content;
  });
  app.get("/api/skills/tools", async () => {
    return Promise.all(catalogToolCommands().map(async ([name, command]) => {
      return { name, found: Boolean(await findExecutable(command)) };
    }));
  });
  app.post("/api/skills/validate", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const pathValue = (request.query as { path?: string }).path;
    let target = pathValue
      ? (isAbsolute(pathValue) || pathValue.startsWith("~/") || pathValue.startsWith("~\\") ? expandUserPath(pathValue) : resolve(root, pathValue))
      : join(root, ".pi", "skills");
    try {
      const info = await stat(target);
      target = info.isFile() ? dirname(await realpath(target)) : await realpath(target);
    } catch {
      /* let scanner return no skills */
    }
    if (!pathIsInside(root, target, true) || target.split(/[\\/]/).some((part) => part.toLowerCase() === ".pi-science")) {
      return reply.code(403).send({ error: "Skill path must remain inside the workspace" });
    }
    const validations = await validateSkillDir(target);
    return {
      valid: validations.length > 0 && validations.every((v) => v.valid),
      validations,
    };
  });

async function loadMcpDefinitions(root: string): Promise<{ definitions: Record<string, unknown>; source: string | null }> {
  const paths = [join(root, ".mcp.json"), join(root, ".pi", "mcp.json"), configPath("mcp.json")];
  for (const path of paths) {
    try {
      const definitions = ((JSON.parse(await readFile(path, "utf8")) as { mcpServers?: unknown }).mcpServers ?? {}) as Record<string, unknown>;
      return { definitions, source: path };
    } catch { /* try next */ }
  }
  return { definitions: {}, source: null };
}

function summarizeMcpServers(definitions: Record<string, unknown>, enabled: ReadonlySet<string>): Array<Record<string, unknown>> {
  return Object.keys(definitions).sort().map((id) => {
    const definition = (definitions[id] as Record<string, unknown> | undefined) ?? {};
    const remote = Boolean(definition.url);
    return {
      id,
      name: String(definition.name ?? id),
      description: String(definition.description ?? ""),
      transport: remote ? String(definition.transport ?? "http") : definition.command ? "stdio" : "unknown",
      enabled: enabled.has(id),
      auth: definition.required_env ? "missing" : "unknown",
      data_egress: remote ? "remote" : "local",
      terms_url: definition.terms_url ?? null,
      privacy_url: definition.privacy_url ?? null,
      license: definition.license ?? null,
      tags: Array.isArray(definition.tags) ? definition.tags : [],
      tools: Array.isArray(definition.tools) ? definition.tools : [],
    };
  });
}

async function mcpEnabledSet(definitions: Record<string, unknown>): Promise<Set<string>> {
  const config = await readJson<{ mcp_servers?: string[] }>(configPath("config.json"), {});
  return Array.isArray(config.mcp_servers) ? new Set(config.mcp_servers) : new Set(Object.keys(definitions));
}

// ── MCP catalog ──
  app.get("/api/mcp/catalog", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const { definitions, source } = await loadMcpDefinitions(root); const servers = summarizeMcpServers(definitions, await mcpEnabledSet(definitions)); return { servers, config_path: source }; });
  app.get<{ Params: { server_id: string } }>("/api/mcp/health/:server_id", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const { definitions } = await loadMcpDefinitions(root);
    const definition = definitions[request.params.server_id];
    if (!definition) return reply.code(404).send({ error: "MCP server not found" });
    const enabled = await mcpEnabledSet(definitions);
    const server = summarizeMcpServers(definitions, enabled).find((item) => item.id === request.params.server_id);
    if (!server) return reply.code(404).send({ error: "MCP server not found" });
    if (!server.enabled) return { ...server, health: "blocked", error: "server disabled", checked_at: Date.now() / 1000 };
    const result = await probeMcpHealth(definition as McpDefinition);
    return { ...server, health: result.health, error: result.error, checked_at: Date.now() / 1000 };
  });
  app.get<{ Params: { server_id: string } }>("/api/mcp/egress/:server_id", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const { definitions } = await loadMcpDefinitions(root);
    const server = summarizeMcpServers(definitions, new Set(Object.keys(definitions))).find((item) => item.id === request.params.server_id);
    if (!server) return reply.code(404).send({ error: "MCP server not found" });
    const auditEnabled = await egressAuditEnabled();
    if (server.data_egress === "remote" && auditEnabled) {
      const url = typeof (definitions[request.params.server_id] as Record<string, unknown> | undefined)?.url === "string" ? String((definitions[request.params.server_id] as Record<string, unknown>).url) : "";
      await recordEgress({ connector_type: "mcp", connector_id: request.params.server_id, target_domain: url, approved: false, note: "egress_review" });
    }
    return { server: request.params.server_id, data_egress: server.data_egress, transport: server.transport, terms_url: server.terms_url, privacy_url: server.privacy_url, tools: server.tools, warning: server.data_egress === "remote" ? "Review the destination and data class before sending user files or sequences." : null, audit_enabled: auditEnabled };
  });

  // ── Workspaces ──
  app.get("/api/workspaces", async () => { const result = await Promise.all((await knownWorkspacePaths()).map((path) => workspaceInfo(path))); return result.sort((left, right) => String(right.last_modified).localeCompare(String(left.last_modified))); });
  app.post("/api/workspaces", async (request, reply) => { const body = (request.body ?? {}) as { name?: unknown }; const name = String(body.name ?? "").trim().replace(/[\\/]/g, "-").slice(0, 100); if (!name) return reply.code(400).send({ error: "Invalid workspace name" }); const path = join(rootDir(), name); try { await stat(path); return reply.code(409).send({ error: "Workspace already exists" }); } catch { /* create */ } await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".pi-science"), { recursive: true })); return await workspaceInfo(path); });
  app.post("/api/workspaces/open", async (request, reply) => { const requestedPath = expandUserPath(String(((request.body ?? {}) as { path?: unknown }).path ?? "")); let path: string; try { if (!(await stat(requestedPath)).isDirectory()) return reply.code(400).send({ error: "Not a directory" }); path = await realpath(requestedPath); } catch { return reply.code(404).send({ error: "Folder not found" }); } await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".pi-science"), { recursive: true })); await rememberExternalWorkspace(path); return await workspaceInfo(path); });
  app.post("/api/workspaces/demo", async (request, reply) => {
    const demo = DEMOS[String((request.query as { name?: unknown }).name ?? "")];
    if (!demo) return reply.code(400).send({ error: "Unknown demo" });
    const root = rootDir();
    const target = resolve(root, demo.workspace);
    if (!pathIsInside(root, target)) return reply.code(403).send({ error: "Demo target escapes the workspaces directory" });
    const source = join(PROJECT_ROOT, demo.source);
    try { if (!(await stat(source)).isDirectory()) throw new Error("not a directory"); }
    catch { return reply.code(500).send({ error: `Demo content is missing from this installation (${demo.source})` }); }
    // Preserve edits only when this workspace was installed from the same
    // source. A changed or missing sentinel means the bundled demo has been
    // upgraded and the stale generated workspace must be rebuilt.
    const sentinel = join(target, ".pi-science", "demo-source");
    let installed = false;
    try {
      installed = (await readFile(sentinel, "utf8")).trim() === demo.source;
    } catch { /* first install or legacy workspace */ }
    if (!installed) {
      try { await rm(target, { recursive: true, force: true }); } catch { /* create below */ }
      await cp(source, target, { recursive: true });
    }
    await mkdir(join(target, ".pi-science"), { recursive: true });
    await writeFile(sentinel, `${demo.source}\n`, "utf8");
    return await workspaceInfo(target);
  });
  app.post("/api/workspaces/rename", async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown; name?: unknown };
    let source: string;
    try { source = await managedWorkspacePath(String(body.path ?? ""), "rename"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return reply.code(404).send({ error: "Workspace not found" });
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const root = rootDir();
    const name = String(body.name ?? "").trim().replace(/[\\/]/g, "-").slice(0, 100);
    if (!name) return reply.code(400).send({ error: "Invalid workspace name" });
    if (await research?.hasActive(source) || await jobs?.hasActive(source)) return reply.code(409).send({ error: "Pause or cancel active research and jobs before renaming this workspace" });
    const destination = join(root, name);
    try { await stat(destination); return reply.code(409).send({ error: "Workspace already exists" }); } catch { /* available */ }
    try {
      await rename(source, destination);
      await updatePinnedWorkspace(source, destination);
      await updateProject(destination, { name });
      return await workspaceInfo(destination);
    } catch { return reply.code(404).send({ error: "Workspace not found" }); }
  });
  app.get("/api/workspaces/pinned", async () => ({ paths: await readJson<string[]>(configPath("pinned.json"), []) }));
  app.post("/api/workspaces/pin", async (request) => { const path = String(((request.body ?? {}) as { path?: unknown }).path ?? ""); const paths = await readJson<string[]>(configPath("pinned.json"), []); if (!paths.includes(path)) paths.push(path); await writeJsonAtomic(configPath("pinned.json"), paths); return { ok: true, pinned: true }; });
  app.post("/api/workspaces/unpin", async (request) => { const path = String(((request.body ?? {}) as { path?: unknown }).path ?? ""); const paths = (await readJson<string[]>(configPath("pinned.json"), [])).filter((item) => item !== path); await writeJsonAtomic(configPath("pinned.json"), paths); return { ok: true, pinned: false }; });
  app.delete("/api/workspaces/delete", async (request, reply) => {
    let path: string;
    try { path = await managedWorkspacePath(String(((request.body ?? {}) as { path?: unknown }).path ?? ""), "delete"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return reply.code(404).send({ error: "Workspace not found" });
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (await research?.hasActive(path) || await jobs?.hasActive(path)) return reply.code(409).send({ error: "Cancel active research and jobs before deleting this workspace" });
    try { await rm(path, { recursive: true }); return { ok: true }; } catch { return reply.code(404).send({ error: "Workspace not found" }); }
  });

  // ── Compute machine registry ──
  app.get("/api/compute/machines", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const value = await readJson<{ machines?: unknown[] }>(join(root, ".pi-science", "compute.json"), {}); return { machines: Array.isArray(value.machines) ? value.machines : [] }; });
  app.post("/api/compute/machines", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const machine = (request.body ?? {}) as Record<string, unknown>; if (!machine.host) return reply.code(400).send({ error: "host is required" }); const port = Number(machine.port ?? 22); if (!Number.isInteger(port) || port < 1 || port > 65535) return reply.code(400).send({ error: "port must be between 1 and 65535" }); const path = join(root, ".pi-science", "compute.json"); const current = await readJson<{ machines?: Record<string, unknown>[] }>(path, {}); const machines = Array.isArray(current.machines) ? current.machines : []; const { password: _password, ...safeMachine } = machine; const item = { ...safeMachine, port, identity_file: String(machine.identity_file ?? "~/.ssh/id_rsa"), auth_method: machine.auth_method === "password" ? "password" : "key", label: String(machine.label ?? machine.host) }; const next = [...machines.filter((row) => row.label !== item.label), item]; await writeJsonAtomic(path, { machines: next }); return { ok: true, machines: next }; });
  app.delete<{ Params: { label: string } }>("/api/compute/machines/:label", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const path = join(root, ".pi-science", "compute.json"); const current = await readJson<{ machines?: Record<string, unknown>[] }>(path, {}); await writeJsonAtomic(path, { machines: (current.machines ?? []).filter((row) => row.label !== request.params.label) }); return { ok: true }; });
  app.post("/api/compute/probe", async (request, reply) => { const root = await ws(request, reply); if (!root) return; return probeComputeMachine((request.body ?? {}) as ComputeProbeInput); });
  app.post("/api/compute/run", async (request, reply) => {
    const cwd = await ws(request, reply);
    if (!cwd) return;
    if (!remoteJobs) return reply.code(503).send({ error: "Remote dispatch is not configured" });
    const body = (request.body ?? {}) as { machine_label?: string; command?: unknown; output_glob?: unknown };
    if (!body.machine_label) return reply.code(422).send({ error: "machine_label is required" });
    const command = typeof body.command === "string"
      ? body.command
      : Array.isArray(body.command)
        ? body.command.map(String)
        : null;
    if (command === null || (typeof command === "string" ? !command.trim() : command.length === 0)) return reply.code(422).send({ error: "command must be a non-empty string or array" });
    const result = await remoteJobs.submit(cwd, { machine_label: String(body.machine_label), command, output_glob: body.output_glob === undefined ? undefined : String(body.output_glob) });
    if ("error" in result) {
      const status = result.code === "machine_not_found" ? 404 : result.code === "invalid_command" || result.code === "invalid_output_glob" ? 422 : 502;
      return reply.code(status).send({ error: result.error });
    }
    return { ok: true, job: result };
  });
  app.get("/api/compute/jobs", async (request, reply) => { const cwd = await ws(request, reply); if (!cwd) return; if (!remoteJobs) return reply.code(503).send({ error: "Remote dispatch is not configured" }); return { jobs: await remoteJobs.list(cwd) }; });
  app.get<{ Params: { job_id: string } }>("/api/compute/jobs/:job_id", async (request, reply) => { const cwd = await ws(request, reply); if (!cwd) return; if (!remoteJobs) return reply.code(503).send({ error: "Remote dispatch is not configured" }); const job = await remoteJobs.refresh(cwd, request.params.job_id); return job ?? reply.code(404).send({ error: "Remote job not found" }); });
  app.post<{ Params: { job_id: string } }>("/api/compute/jobs/:job_id/cancel", async (request, reply) => { const cwd = await ws(request, reply); if (!cwd) return; if (!remoteJobs) return reply.code(503).send({ error: "Remote dispatch is not configured" }); const job = await remoteJobs.cancel(cwd, request.params.job_id); return job ?? reply.code(404).send({ error: "Remote job not found" }); });
  app.post<{ Params: { job_id: string } }>("/api/compute/jobs/:job_id/harvest", async (request, reply) => { const cwd = await ws(request, reply); if (!cwd) return; if (!remoteJobs) return reply.code(503).send({ error: "Remote dispatch is not configured" }); const sessionId = String((request.query as { session_id?: unknown }).session_id ?? ""); const result = await remoteJobs.harvest(cwd, request.params.job_id, sessionId || undefined); return result.error ? reply.code(409).send({ error: result.error }) : result; });

  // ── Citations ──
  app.post("/api/citations/normalize", async (request) => { const identifiers = Array.isArray(((request.body ?? {}) as { identifiers?: unknown }).identifiers) ? ((request.body as { identifiers: unknown[] }).identifiers) : []; const citations = identifiers.map((value) => { const text = String(value).trim(); const doi = text.replace(/^https?:\/\/doi\.org\//i, ""); return { identifier: text, doi: doi.toLowerCase().startsWith("10.") ? doi : null, title: null, authors: [], year: null, source: text.includes("10.") ? "doi" : "unknown" }; }); return { citations, errors: [] }; });
  app.post("/api/citations/verify", async (request) => { const citation = ((request.body ?? {}) as { citation?: unknown }).citation; return { citation, status: "unverified", verified: false, message: "Verification is delegated to the literature runtime" }; });

  // ── Agent profiles & reviews ──
  app.get("/api/agent-profiles", async () => ({ profiles: [
    { name: "SCIENCE", display_name: "Science Agent", description: "General scientific workbench agent", unrestricted: true, source: "builtin" },
    { name: "RESULT_REVIEWER", display_name: "Result Reviewer", description: "Read-only transcript and artifact consistency reviewer", skills: ["literature-review"], read_scope: ["workspace", "transcript", "artifacts"], write_scope: [], source: "builtin" },
    { name: "BOOKMARKER", display_name: "Transcript Bookmarker", description: "Selects durable navigation breadcrumbs", skills: [], read_scope: ["transcript"], write_scope: ["bookmarks"], source: "builtin" },
  ] }));
  app.get("/api/result-reviews", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const { readJsonLines, workspaceFile } = await import("../../storage/persistence.js"); return { reviews: await readJsonLines<Record<string, unknown>>(workspaceFile(root, "result-reviews.jsonl")) }; });
  app.post("/api/result-reviews", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const sessionId = String((request.query as { session_id?: unknown }).session_id ?? ""); if (!sessionId) return reply.code(400).send({ error: "session_id is required" }); const messages = await sessionRepository.messages(root, sessionId); const text = messages.flatMap((message) => message.content).map((part) => typeof part.text === "string" ? part.text : "").join("\n"); const findings = /\b(ran|executed|tested|verified|measured|computed)\b/i.test(text) && !messages.some((message) => message.content.some((part) => part.type === "toolCall" || part.type === "toolResult")) ? [{ severity: "fail", kind: "unsupported_execution_claim", message: "Transcript claims an execution or verification action but contains no corresponding tool record." }] : []; const result = { review_id: `review_${Date.now()}`, session_id: sessionId, status: findings.length ? "fail" : "pass", findings, checked_messages: messages.length, created_at: Date.now() / 1000 }; const { appendJsonLine, workspaceFile } = await import("../../storage/persistence.js"); await appendJsonLine(workspaceFile(root, "result-reviews.jsonl"), result); return result; });
}
