import { mcpToolGrantUpdateSchema } from "@pi-science/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { McpConnectorService, McpServiceError } from "../../mcp/connector-service.js";

const importCommitSchema = z.object({ names: z.array(z.string().min(1).max(64)).min(1).max(100) });

function cwd(request: { query: unknown }): string {
  const value = (request.query as { cwd?: unknown }).cwd;
  return typeof value === "string" && value ? value : ".";
}

function failure(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof McpServiceError) {
    return reply.code(error.status).send({ error: error.message, code: error.code, details: error.details });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: "Invalid MCP request", code: "invalid_request", issues: error.issues });
  }
  throw error;
}

export function registerMcpRoutes(app: FastifyInstance, service: McpConnectorService): void {
  app.get("/api/mcp/connectors", async (request, reply) => {
    try { return await service.list(cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.post("/api/mcp/connectors", async (request, reply) => {
    try { return reply.code(201).send(await service.create(request.body, cwd(request))); }
    catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { connector_id: string } }>("/api/mcp/connectors/:connector_id", async (request, reply) => {
    try { return await service.get(request.params.connector_id, cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.patch<{ Params: { connector_id: string } }>("/api/mcp/connectors/:connector_id", async (request, reply) => {
    try { return await service.update(request.params.connector_id, request.body, cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.delete<{ Params: { connector_id: string } }>("/api/mcp/connectors/:connector_id", async (request, reply) => {
    try { await service.remove(request.params.connector_id, cwd(request)); return reply.code(204).send(); }
    catch (error) { return failure(reply, error); }
  });

  app.put<{ Params: { connector_id: string } }>("/api/mcp/connectors/:connector_id/binding", async (request, reply) => {
    try { return await service.setBinding(request.params.connector_id, request.body, cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.post<{ Params: { connector_id: string } }>("/api/mcp/connectors/:connector_id/probe", async (request, reply) => {
    try { return await service.probe(request.params.connector_id, cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { connector_id: string } }>("/api/mcp/connectors/:connector_id/tools", async (request, reply) => {
    try { return await service.tools(request.params.connector_id, cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.put<{ Params: { connector_id: string; tool_name: string } }>("/api/mcp/connectors/:connector_id/tools/:tool_name", async (request, reply) => {
    try {
      const { decision } = mcpToolGrantUpdateSchema.parse(request.body);
      await service.setToolGrant(request.params.connector_id, request.params.tool_name, decision, cwd(request));
      return { ok: true };
    } catch (error) { return failure(reply, error); }
  });

  app.post("/api/mcp/import/preview", async (request, reply) => {
    try { return await service.importPreview(cwd(request)); }
    catch (error) { return failure(reply, error); }
  });

  app.post("/api/mcp/import/commit", async (request, reply) => {
    try { return await service.importCommit(importCommitSchema.parse(request.body).names, cwd(request)); }
    catch (error) { return failure(reply, error); }
  });
}
