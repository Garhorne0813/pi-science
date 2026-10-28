import {
  legacyArchives,
  exportLegacyArchive,
} from "../../project-review/legacy-archives.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
export function registerProjectRoutes(app: FastifyInstance): void {
  app.get("/api/project/archives", async (req) => {
    const cwd = await projectWorkspace(
      (req.query as { cwd?: string }).cwd ?? ".",
    );
    return { archives: await legacyArchives(cwd) };
  });
  app.post<{ Params: { id: string } }>(
    "/api/project/archives/:id/export",
    async (req, reply) => {
      const cwd = await projectWorkspace(
        (req.query as { cwd?: string }).cwd ?? ".",
      );
      const archive = await exportLegacyArchive(cwd, req.params.id);
      return archive
        ? { archive }
        : reply.code(404).send({ error: "Archive not found" });
    },
  );
  app.get("/api/project/document", async (req) => {
    const cwd = await projectWorkspace(
      (req.query as { cwd?: string }).cwd ?? ".",
    );
    try {
      return { content: await readFile(join(cwd, "PROJECT.md"), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { content: "" };
      throw error;
    }
  });
  app.put("/api/project/document", async (req, reply) => {
    const cwd = await projectWorkspace(
      (req.query as { cwd?: string }).cwd ?? ".",
    );
    const { content } = (req.body ?? {}) as { content?: unknown };
    if (typeof content !== "string")
      return reply.code(400).send({ error: "content must be text" });
    await writeFile(join(cwd, "PROJECT.md"), content, "utf8");
    return { ok: true };
  });
}

async function projectWorkspace(value: string) {
  try {
    return await validateWorkspaceCwd(value);
  } catch (error) {
    throw Object.assign(new Error(String(error)), { statusCode: 403 });
  }
}
