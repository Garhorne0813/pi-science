import type { FastifyInstance } from "fastify";
import type { WorkspaceEnvironmentService } from "../../runtime/workspace/workspace-environment.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { z } from "zod";

const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(64),
  display_name: z.string().min(1).max(100).optional(),
  language: z.enum(["python", "r"]).optional(),
  packages: z.array(z.string().min(1).max(300)).max(200).optional(),
  supersedes_revision_id: z.string().min(1).optional(),
});

const bindEnvironmentSchema = z.object({ revision_id: z.string().min(1) });

const installPackagesSchema = z.object({
  packages: z.array(z.string().min(1).max(300)).min(1).max(200),
});

async function workspace(request: { query: unknown }): Promise<string> {
  const value = (request.query as { cwd?: unknown }).cwd;
  return validateWorkspaceCwd(typeof value === "string" ? value : "");
}

export function registerEnvironmentRoutes(app: FastifyInstance, environments: WorkspaceEnvironmentService): void {
  app.get("/api/environments", async () => ({ environments: await environments.list() }));

  app.post("/api/environments", async (request, reply) => {
    const parsed = createEnvironmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid environment request" });
    try { return await environments.create(parsed.data); }
    catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/environments/workspace", async (request, reply) => {
    try { return await environments.status(await workspace(request)); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
  });
  app.post("/api/environments/workspace", async (request, reply) => {
    let cwd: string;
    try { cwd = await workspace(request); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try { return await environments.ensure(cwd); }
    catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.put("/api/environments/workspace", async (request, reply) => {
    const parsed = bindEnvironmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid environment binding request" });
    let cwd: string;
    try { cwd = await workspace(request); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try { return await environments.bind(cwd, parsed.data.revision_id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/environments/workspace/packages", async (request, reply) => {
    const parsed = installPackagesSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid package install request" });
    let cwd: string;
    try { cwd = await workspace(request); }
    catch (error) { return reply.code(403).send({ error: String(error) }); }
    try { return await environments.installPackages(cwd, parsed.data.packages); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
