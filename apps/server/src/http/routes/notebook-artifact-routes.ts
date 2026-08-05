import type { FastifyInstance } from "fastify";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";
import { ChatNotebookService, type ChatCellResult } from "../../runtime/notebook/chat-notebook-service.js";
import { recordProvenance } from "./artifact-routes.js";

function statusCode(code: string): number {
  switch (code) {
    case "invalid_request": return 400;
    case "workspace_invalid": return 403;
    case "not_found": return 404;
    case "conflict": return 409;
    case "code_too_large":
    case "result_too_large": return 413;
    default: return 400;
  }
}

export function registerNotebookArtifactRoutes(app: FastifyInstance, service = new ChatNotebookService()): void {
  app.post("/api/artifacts/notebooks/save", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    const cwdValue = typeof query.cwd === "string" && query.cwd ? query.cwd : ".";
    let cwd: string;
    try {
      cwd = await validateWorkspaceCwd(cwdValue);
    } catch (error) {
      return reply.code(403).send({ ok: false, code: "workspace_invalid", error: String(error) });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const outcome = await service.save(cwd, {
      session_id: typeof body.session_id === "string" ? body.session_id : "",
      message_id: typeof body.message_id === "string" ? body.message_id : "",
      source_line: typeof body.source_line === "string" ? body.source_line : undefined,
      language: typeof body.language === "string" ? body.language : undefined,
      code: typeof body.code === "string" ? body.code : "",
      result: body.result && typeof body.result === "object" ? body.result as ChatCellResult : null,
      model_at_save: typeof body.model_at_save === "string" ? body.model_at_save : null,
    });
    if (!outcome.ok) return reply.code(statusCode(outcome.code)).send(outcome);
    const provenance = await recordProvenance(cwd, {
      path: outcome.path,
      session_id: String(body.session_id ?? ""),
      tool: "chat_save_notebook",
      ...(typeof body.model_at_save === "string" ? { model: body.model_at_save } : {}),
      content: `notebook:${outcome.path}:cells=${outcome.cell_count}:${outcome.updated ? "updated" : "appended"}`,
    });
    return {
      ok: true,
      path: outcome.path,
      created_notebook: outcome.created_notebook,
      appended: outcome.appended,
      updated: outcome.updated,
      cell_index: outcome.cell_index,
      cell_count: outcome.cell_count,
      revision: provenance.version,
    };
  });
}
