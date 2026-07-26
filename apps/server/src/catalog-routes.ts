import { access, cp, mkdir, readdir, readFile, realpath, rename, stat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { configPath, readJson, writeJsonAtomic } from "./persistence.js";
import { validateWorkspaceCwd } from "./workspace-security.js";
import { sessionRepository } from "./session-repository.js";
import { catalog as skillCatalog, getSkillInfo, validateDirectory as validateSkillDir } from "./skill-catalog.js";
import type { JobCoordinator } from "./job-coordinator.js";
import type { ResearchLoopCoordinator } from "./research-loop/coordinator.js";

function q(request: { query: unknown }, key: string, fallback = "."): string { const value = (request.query as Record<string, unknown>)[key]; return typeof value === "string" && value ? value : fallback; }
async function ws(request: { query: unknown }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }): Promise<string | null> { try { return await validateWorkspaceCwd(q(request, "cwd")); } catch (error) { reply.code(403).send({ error: String(error) }); return null; } }
function rootDir(): string { return resolve(process.env.PI_SCIENCE_WORKSPACES ?? join(process.env.HOME ?? ".", "pi-science-workspaces")); }
export async function knownWorkspacePaths(): Promise<string[]> {
  const paths = new Set<string>();
  try {
    for (const name of await readdir(rootDir())) {
      const path = join(rootDir(), name);
      try { if ((await stat(join(path, ".pi-science"))).isDirectory()) paths.add(path); } catch { /* skip */ }
    }
  } catch { /* workspace root absent */ }
  for (const value of await readJson<string[]>(configPath("pinned.json"), [])) {
    const path = resolve(value);
    try { if ((await stat(join(path, ".pi-science"))).isDirectory()) paths.add(path); } catch { /* stale pin */ }
  }
  return [...paths];
}
async function workspaceInfo(path: string): Promise<Record<string, unknown>> {
  const [sessions, metadata] = await Promise.all([
    sessionRepository.list(path),
    stat(path),
  ]);
  return {
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    session_count: sessions.length,
    last_modified: metadata.mtime.toISOString(),
  };
}
function inside(root: string, target: string): boolean { const rel = relative(root, target); return !rel.startsWith("..") && !isAbsolute(rel); }
function expandUserPath(path: string): string { return path.startsWith("~/") ? resolve(process.env.HOME ?? ".", path.slice(2)) : resolve(path); }

// src/ (or dist/) -> apps/server/ -> apps/ -> project root, where the shipped demo assets live.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The two demo cards the projects page offers; the request name is an allowlist key, never a path. */
const DEMOS: Record<string, { source: string; workspace: string }> = {
  molecules: { source: "demo-molecules", workspace: "Molecular Playground" },
  climate: { source: "demo", workspace: "Climate Trends" },
};

export function registerCatalogRoutes(app: FastifyInstance, jobs?: JobCoordinator, research?: ResearchLoopCoordinator): void {
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
  app.get("/api/skills/tools", async () => {
    const commands = [["python", "python3"], ["Node.js", "node"], ["Git", "git"], ["uv", "uv"]] as const;
    return Promise.all(commands.map(async ([name, command]) => {
      try {
        await access(resolve(process.env.PATH?.split(":").find((path) => path) ?? "/usr/bin", command));
        return { name, found: true };
      } catch {
        return { name, found: false };
      }
    }));
  });
  app.post("/api/skills/validate", async (request, reply) => {
    const root = await ws(request, reply);
    if (!root) return;
    const pathValue = (request.query as { path?: string }).path;
    let target = pathValue
      ? (isAbsolute(pathValue) || pathValue.startsWith("~/") ? expandUserPath(pathValue) : resolve(root, pathValue))
      : join(root, ".pi", "skills");
    try {
      const info = await stat(target);
      target = info.isFile() ? dirname(await realpath(target)) : await realpath(target);
    } catch {
      /* let scanner return no skills */
    }
    if (!inside(root, target) || target.split(/[\\/]/).includes(".pi-science")) {
      return reply.code(403).send({ error: "Skill path must remain inside the workspace" });
    }
    const validations = await validateSkillDir(target);
    return {
      valid: validations.length > 0 && validations.every((v) => v.valid),
      validations,
    };
  });

  // ── MCP catalog ──
  app.get("/api/mcp/catalog", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const paths = [join(root, ".mcp.json"), join(root, ".pi", "mcp.json"), configPath("mcp.json")]; let source: string | undefined; let definitions: Record<string, unknown> = {}; for (const path of paths) { try { definitions = ((JSON.parse(await readFile(path, "utf8")) as { mcpServers?: unknown }).mcpServers ?? {}) as Record<string, unknown>; source = path; break; } catch { /* try next */ } } const config = await readJson<{ mcp_servers?: string[] }>(configPath("config.json"), {}); const ids = Object.keys(definitions); const enabled = Array.isArray(config.mcp_servers) ? new Set(config.mcp_servers) : new Set(ids); const servers = ids.sort().map((id) => { const definition = definitions[id] as Record<string, unknown> | undefined ?? {}; const remote = Boolean(definition.url); return { id, name: String(definition.name ?? id), description: String(definition.description ?? ""), transport: remote ? String(definition.transport ?? "http") : definition.command ? "stdio" : "unknown", enabled: enabled.has(id), auth: definition.required_env ? "missing" : "unknown", data_egress: remote ? "remote" : "local", terms_url: definition.terms_url ?? null, privacy_url: definition.privacy_url ?? null, license: definition.license ?? null, tags: Array.isArray(definition.tags) ? definition.tags : [], tools: Array.isArray(definition.tools) ? definition.tools : [] }; }); return { servers, config_path: source ?? null }; });
  app.get<{ Params: { server_id: string } }>("/api/mcp/health/:server_id", async (request, reply) => { const catalog = await app.inject({ method: "GET", url: `/api/mcp/catalog?cwd=${encodeURIComponent(q(request, "cwd"))}` }); const server = (catalog.json() as { servers: Array<Record<string, unknown>> }).servers.find((item) => item.id === request.params.server_id); if (!server) return reply.code(404).send({ error: "MCP server not found" }); return { ...server, health: server.enabled ? "unknown" : "blocked", error: server.enabled ? null : "server disabled" }; });
  app.get<{ Params: { server_id: string } }>("/api/mcp/egress/:server_id", async (request, reply) => { const catalog = await app.inject({ method: "GET", url: `/api/mcp/catalog?cwd=${encodeURIComponent(q(request, "cwd"))}` }); const server = (catalog.json() as { servers: Array<Record<string, unknown>> }).servers.find((item) => item.id === request.params.server_id); if (!server) return reply.code(404).send({ error: "MCP server not found" }); return { server: request.params.server_id, data_egress: server.data_egress, transport: server.transport, terms_url: server.terms_url, privacy_url: server.privacy_url, tools: server.tools, warning: server.data_egress === "remote" ? "Review the destination and data class before sending user files or sequences." : null }; });

  // ── Workspaces ──
  app.get("/api/workspaces", async () => { const result = await Promise.all((await knownWorkspacePaths()).map((path) => workspaceInfo(path))); return result.sort((left, right) => String(right.last_modified).localeCompare(String(left.last_modified))); });
  app.post("/api/workspaces", async (request, reply) => { const body = (request.body ?? {}) as { name?: unknown }; const name = String(body.name ?? "").trim().replace(/[\\/]/g, "-").slice(0, 100); if (!name) return reply.code(400).send({ error: "Invalid workspace name" }); const path = join(rootDir(), name); try { await stat(path); return reply.code(409).send({ error: "Workspace already exists" }); } catch { /* create */ } await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".pi-science"), { recursive: true })); return await workspaceInfo(path); });
  app.post("/api/workspaces/open", async (request, reply) => { const path = expandUserPath(String(((request.body ?? {}) as { path?: unknown }).path ?? "")); try { if (!(await stat(path)).isDirectory()) return reply.code(400).send({ error: "Not a directory" }); } catch { return reply.code(404).send({ error: "Folder not found" }); } await import("node:fs/promises").then(({ mkdir }) => mkdir(join(path, ".pi-science"), { recursive: true })); return await workspaceInfo(path); });
  app.post("/api/workspaces/demo", async (request, reply) => {
    const demo = DEMOS[String((request.query as { name?: unknown }).name ?? "")];
    if (!demo) return reply.code(400).send({ error: "Unknown demo" });
    const root = rootDir();
    const target = resolve(root, demo.workspace);
    if (!inside(root, target) || target === root) return reply.code(403).send({ error: "Demo target escapes the workspaces directory" });
    const source = join(PROJECT_ROOT, demo.source);
    try { if (!(await stat(source)).isDirectory()) throw new Error("not a directory"); }
    catch { return reply.code(500).send({ error: `Demo content is missing from this installation (${demo.source})` }); }
    // A repeat install opens the workspace the user already has instead of overwriting their edits.
    let installed = true;
    try { await stat(target); } catch { installed = false; }
    if (!installed) await cp(source, target, { recursive: true });
    await mkdir(join(target, ".pi-science"), { recursive: true });
    return await workspaceInfo(target);
  });
  app.post("/api/workspaces/rename", async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown; name?: unknown };
    const source = resolve(String(body.path ?? ""));
    const root = rootDir();
    if (!inside(root, source) || source === root) return reply.code(403).send({ error: "Cannot rename outside workspaces directory" });
    const name = String(body.name ?? "").trim().replace(/[\\/]/g, "-").slice(0, 100);
    if (!name) return reply.code(400).send({ error: "Invalid workspace name" });
    if (await research?.hasActive(source) || await jobs?.hasActive(source)) return reply.code(409).send({ error: "Pause or cancel active research and jobs before renaming this workspace" });
    const destination = join(root, name);
    try { await stat(destination); return reply.code(409).send({ error: "Workspace already exists" }); } catch { /* available */ }
    try {
      await rename(source, destination);
      const pinned = await readJson<string[]>(configPath("pinned.json"), []);
      if (pinned.includes(source)) await writeJsonAtomic(configPath("pinned.json"), pinned.map((path) => path === source ? destination : path));
      return await workspaceInfo(destination);
    } catch { return reply.code(404).send({ error: "Workspace not found" }); }
  });
  app.get("/api/workspaces/pinned", async () => ({ paths: await readJson<string[]>(configPath("pinned.json"), []) }));
  app.post("/api/workspaces/pin", async (request) => { const path = String(((request.body ?? {}) as { path?: unknown }).path ?? ""); const paths = await readJson<string[]>(configPath("pinned.json"), []); if (!paths.includes(path)) paths.push(path); await writeJsonAtomic(configPath("pinned.json"), paths); return { ok: true, pinned: true }; });
  app.post("/api/workspaces/unpin", async (request) => { const path = String(((request.body ?? {}) as { path?: unknown }).path ?? ""); const paths = (await readJson<string[]>(configPath("pinned.json"), [])).filter((item) => item !== path); await writeJsonAtomic(configPath("pinned.json"), paths); return { ok: true, pinned: false }; });
  app.delete("/api/workspaces/delete", async (request, reply) => { const path = resolve(String(((request.body ?? {}) as { path?: unknown }).path ?? "")); if (!path.startsWith(`${rootDir()}${process.platform === "win32" ? "\\" : "/"}`)) return reply.code(403).send({ error: "Cannot delete outside workspaces directory" }); if (await research?.hasActive(path) || await jobs?.hasActive(path)) return reply.code(409).send({ error: "Cancel active research and jobs before deleting this workspace" }); try { await rm(path, { recursive: true }); return { ok: true }; } catch { return reply.code(404).send({ error: "Workspace not found" }); } });

  // ── Compute machine registry ──
  app.get("/api/compute/machines", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const value = await readJson<{ machines?: unknown[] }>(join(root, ".pi-science", "compute.json"), {}); return { machines: Array.isArray(value.machines) ? value.machines : [] }; });
  app.post("/api/compute/machines", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const machine = (request.body ?? {}) as Record<string, unknown>; if (!machine.host) return reply.code(400).send({ error: "host is required" }); const path = join(root, ".pi-science", "compute.json"); const current = await readJson<{ machines?: Record<string, unknown>[] }>(path, {}); const machines = Array.isArray(current.machines) ? current.machines : []; const item = { ...machine, label: String(machine.label ?? machine.host) }; const next = [...machines.filter((row) => row.label !== item.label), item]; await writeJsonAtomic(path, { machines: next }); return { ok: true, machines: next }; });
  app.delete<{ Params: { label: string } }>("/api/compute/machines/:label", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const path = join(root, ".pi-science", "compute.json"); const current = await readJson<{ machines?: Record<string, unknown>[] }>(path, {}); await writeJsonAtomic(path, { machines: (current.machines ?? []).filter((row) => row.label !== request.params.label) }); return { ok: true }; });
  app.post("/api/compute/probe", async (request) => ({ host: String((request.query as { host?: unknown }).host ?? ""), reachable: false, error: "Node remote dispatch is not enabled for this host; configure an executor before probing." }));
  app.post("/api/compute/run", async () => ({ ok: false, error: "Remote dispatch requires a configured executor" }));

  // ── Citations ──
  app.post("/api/citations/normalize", async (request) => { const identifiers = Array.isArray(((request.body ?? {}) as { identifiers?: unknown }).identifiers) ? ((request.body as { identifiers: unknown[] }).identifiers) : []; const citations = identifiers.map((value) => { const text = String(value).trim(); const doi = text.replace(/^https?:\/\/doi\.org\//i, ""); return { identifier: text, doi: doi.toLowerCase().startsWith("10.") ? doi : null, title: null, authors: [], year: null, source: text.includes("10.") ? "doi" : "unknown" }; }); return { citations, errors: [] }; });
  app.post("/api/citations/verify", async (request) => { const citation = ((request.body ?? {}) as { citation?: unknown }).citation; return { citation, status: "unverified", verified: false, message: "Verification is delegated to the literature runtime" }; });

  // ── Agent profiles & reviews ──
  app.get("/api/agent-profiles", async () => ({ profiles: [
    { name: "SCIENCE", display_name: "Science Agent", description: "General scientific workbench agent", unrestricted: true, source: "builtin" },
    { name: "RESULT_REVIEWER", display_name: "Result Reviewer", description: "Read-only transcript and artifact consistency reviewer", skills: ["literature-review"], read_scope: ["workspace", "transcript", "artifacts"], write_scope: [], source: "builtin" },
    { name: "BOOKMARKER", display_name: "Transcript Bookmarker", description: "Selects durable navigation breadcrumbs", skills: [], read_scope: ["transcript"], write_scope: ["bookmarks"], source: "builtin" },
  ] }));
  app.get("/api/result-reviews", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const { readJsonLines, workspaceFile } = await import("./persistence.js"); return { reviews: await readJsonLines<Record<string, unknown>>(workspaceFile(root, "result-reviews.jsonl")) }; });
  app.post("/api/result-reviews", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const sessionId = String((request.query as { session_id?: unknown }).session_id ?? ""); if (!sessionId) return reply.code(400).send({ error: "session_id is required" }); const messages = await sessionRepository.messages(root, sessionId); const text = messages.flatMap((message) => message.content).map((part) => typeof part.text === "string" ? part.text : "").join("\n"); const findings = /\b(ran|executed|tested|verified|measured|computed)\b/i.test(text) && !messages.some((message) => message.content.some((part) => part.type === "toolCall" || part.type === "toolResult")) ? [{ severity: "fail", kind: "unsupported_execution_claim", message: "Transcript claims an execution or verification action but contains no corresponding tool record." }] : []; const result = { review_id: `review_${Date.now()}`, session_id: sessionId, status: findings.length ? "fail" : "pass", findings, checked_messages: messages.length, created_at: Date.now() / 1000 }; const { appendJsonLine, workspaceFile } = await import("./persistence.js"); await appendJsonLine(workspaceFile(root, "result-reviews.jsonl"), result); return result; });
  app.post("/api/bookmarks", async (request, reply) => { const root = await ws(request, reply); if (!root) return; const sessionId = String((request.query as { session_id?: unknown }).session_id ?? ""); if (!sessionId) return reply.code(400).send({ error: "session_id is required" }); const messages = await sessionRepository.messages(root, sessionId); const bookmarks = messages.filter((message) => message.content.some((part) => typeof part.text === "string" && /\b(result|conclusion|finding|decision|saved|created|verified|completed|结果|结论|决定|已保存|已生成)\b/i.test(part.text))).slice(-2).map((message) => ({ session_id: sessionId, message_id: message.id, quote: message.content.map((part) => typeof part.text === "string" ? part.text : "").join("").slice(0, 500) })); const { appendJsonLine, workspaceFile } = await import("./persistence.js"); await appendJsonLine(workspaceFile(root, "bookmarks.jsonl"), { session_id: sessionId, created_at: Date.now() / 1000, bookmarks }); return { session_id: sessionId, bookmarks }; });
}
