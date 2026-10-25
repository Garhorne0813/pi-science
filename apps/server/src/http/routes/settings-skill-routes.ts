import type { FastifyInstance, FastifyReply } from "fastify";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { SettingsStore, type SettingsData as Settings } from "../../storage/settings-store.js";
import { catalog as skillCatalog } from "../../catalog/skill-catalog.js";
import { createProjectSkill, deleteProjectSkill, importGithubSkills, importSkillBundle, MAX_UPLOAD_BYTES, previewGithubSkills, previewSkillUpload, updateProjectSkill } from "../../catalog/project-skill-service.js";
import { knownWorkspacePaths } from "./catalog-routes.js";
import type { RuntimeSkillPolicy } from "../../runtime/agent/agent-runtime-types.js";
import { storedSkillPolicy, skillEnabled, toggledSkillPolicy, reconcileSkillPolicy } from "../../catalog/skill-policy.js";
import { unifiedSkillCatalog } from "../../catalog/managed-skill-catalog.js";
import { query } from "./settings-response.js";

function runtimeSkillFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "runtime_error";
  const status = code === "runtime_busy" ? 409 : code === "runtime_skill_control_unavailable" ? 501 : code === "unknown_runtime_skills" ? 400 : 502;
  return reply.code(status).send({ ok: false, code, error: error instanceof Error ? error.message : String(error) });
}

export function registerSettingsSkillRoutes(app: FastifyInstance, nodeSessionService: NodeSessionService, settingsStore: SettingsStore): void {
  const load = () => settingsStore.read();
  const mutate = <T>(operation: (config: Settings) => T | Promise<T>) => settingsStore.update(operation, { skipUnchanged: true });
  app.get("/api/settings/skills", async (request, reply) => {
    const cwdValue = query(request, "cwd", "");
    const policy = storedSkillPolicy(await load());
    let discovered;
    if (cwdValue) {
      try { discovered = await skillCatalog(await validateWorkspaceCwd(cwdValue)); }
      catch (error) { return reply.code(403).send({ error: String(error) }); }
    } else {
      discovered = await unifiedSkillCatalog(await knownWorkspacePaths());
    }
    const skills = discovered.map((skill) => ({ ...skill, enabled: skillEnabled(policy, skill.name) }));
    return { skills, policy, configured: policy.mode !== "inherit" };
  });
  app.put("/api/settings/skills/toggle", async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; enabled?: unknown };
    const name = String(body.name ?? "").trim();
    const discovered = await unifiedSkillCatalog(await knownWorkspacePaths());
    if (!name || !discovered.some((skill) => skill.name === name)) return reply.code(400).send({ ok: false, code: "unknown_runtime_skills", error: `Unknown runtime skill: ${name || "(empty)"}` });
    const current = reconcileSkillPolicy(storedSkillPolicy(await load()), new Set(discovered.map((skill) => skill.name)));
    const policy = toggledSkillPolicy(current, name, body.enabled === true);
    try {
      await nodeSessionService.refreshAllRuntimeSkills();
      await nodeSessionService.setGlobalSkillPolicy(policy);
    }
    catch (error) { return runtimeSkillFailure(reply, error); }
    await mutate((config) => {
      config.skill_policy = policy;
      delete config.skill_policies;
      delete config.skills_configured;
      delete config.skill_paths;
    });
    return { ok: true, policy, configured: policy.mode !== "inherit" };
  });
  app.post("/api/settings/skills/refresh", async (_request, reply) => {
    const discovered = await unifiedSkillCatalog(await knownWorkspacePaths());
    const policy = reconcileSkillPolicy(storedSkillPolicy(await load()), new Set(discovered.map((skill) => skill.name)));
    try {
      await nodeSessionService.refreshAllRuntimeSkills();
      await nodeSessionService.setGlobalSkillPolicy(policy);
    }
    catch (error) { return runtimeSkillFailure(reply, error); }
    await mutate((config) => {
      if (policy.mode === "inherit") {
        delete config.skill_policy;
      } else config.skill_policy = policy;
      delete config.skill_policies;
    });
    return { ok: true, policy, configured: policy.mode !== "inherit" };
  });
  app.delete("/api/settings/skills", async (_request, reply) => {
    const policy: RuntimeSkillPolicy = { mode: "inherit" };
    try {
      await nodeSessionService.refreshAllRuntimeSkills();
      await nodeSessionService.setGlobalSkillPolicy(policy);
    }
    catch (error) { return runtimeSkillFailure(reply, error); }
    await mutate((config) => {
      delete config.skill_policy;
      delete config.skill_policies;
      delete config.skills_configured;
      delete config.skill_paths;
    });
    return { ok: true, policy, configured: false, message: "Skills reset to auto-discover mode" };
  });
  app.post("/api/settings/skills", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = {
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      body: typeof body.body === "string" ? body.body : "",
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.license === "string" ? { license: body.license } : {}),
      ...(typeof body.category === "string" ? { category: body.category } : {}),
      ...(Array.isArray(body.requirements) ? { requirements: body.requirements as Array<{ name: string; kind?: string; optional?: boolean; version?: string | null }> } : {}),
    };
    try {
      const skill = await createProjectSkill(cwd, input.name, input);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, skill };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) return reply.code(409).send({ ok: false, error: message });
      if (/not found/i.test(message)) return reply.code(404).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.put<{ Params: { skill_id: string } }>("/api/settings/skills/:skill_id", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input = {
      name: request.params.skill_id,
      description: String(body.description ?? ""),
      body: typeof body.body === "string" ? body.body : "",
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.license === "string" ? { license: body.license } : {}),
      ...(typeof body.category === "string" ? { category: body.category } : {}),
      ...(Array.isArray(body.requirements) ? { requirements: body.requirements as Array<{ name: string; kind?: string; optional?: boolean; version?: string | null }> } : {}),
    };
    try {
      const skill = await updateProjectSkill(cwd, request.params.skill_id, input);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, skill };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) return reply.code(404).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.delete<{ Params: { skill_id: string } }>("/api/settings/skills/:skill_id", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try {
      const result = await deleteProjectSkill(cwd, request.params.skill_id);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) return reply.code(404).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.post("/api/settings/skills/upload/preview", async (request, reply) => {
    try { await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { filename?: unknown; content_base64?: unknown };
    const filename = String(body.filename ?? "");
    const content = Buffer.from(String(body.content_base64 ?? ""), "base64");
    if (!filename || content.length === 0) return reply.code(400).send({ ok: false, error: "filename and content_base64 are required" });
    if (content.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ ok: false, error: "Skill upload exceeds the size limit" });
    try {
      const candidates = await previewSkillUpload(filename, content);
      return { ok: true, candidates };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/settings/skills/upload/import", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { filename?: unknown; content_base64?: unknown; root_path?: unknown };
    const filename = String(body.filename ?? "");
    const content = Buffer.from(String(body.content_base64 ?? ""), "base64");
    const rootPath = String(body.root_path ?? ".");
    if (!filename || content.length === 0) return reply.code(400).send({ ok: false, error: "filename and content_base64 are required" });
    if (content.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ ok: false, error: "Skill upload exceeds the size limit" });
    try {
      const skill = await importSkillBundle(cwd, filename, content, rootPath);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, skill };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) return reply.code(409).send({ ok: false, error: message });
      return reply.code(400).send({ ok: false, error: message });
    }
  });
  app.post("/api/settings/skills/import-github/preview", async (request, reply) => {
    const body = (request.body ?? {}) as { repo?: unknown };
    const repo = String(body.repo ?? "");
    if (!repo) return reply.code(400).send({ ok: false, error: "GitHub repository is required" });
    try {
      const candidates = await previewGithubSkills(repo);
      return { ok: true, candidates };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/settings/skills/import-github/import", async (request, reply) => {
    let cwd: string;
    try { cwd = await validateWorkspaceCwd(query(request, "cwd")); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    const body = (request.body ?? {}) as { repo?: unknown; selected?: unknown };
    const repo = String(body.repo ?? "");
    const selected = Array.isArray(body.selected) ? body.selected.map(String).filter(Boolean) : [];
    if (!repo || selected.length === 0) return reply.code(400).send({ ok: false, error: "repo and selected skills are required" });
    try {
      const result = await importGithubSkills(cwd, repo, selected);
      try { await nodeSessionService.refreshAllRuntimeSkills(); }
      catch (error) { return runtimeSkillFailure(reply, error); }
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
