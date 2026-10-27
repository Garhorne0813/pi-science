import { AgentSessionRegistry } from "../../runtime/agent/agent-session-registry.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  MemoryService,
  verifyMemoryGrant,
  LOCAL_OWNER,
} from "../../memory/service.js";
import type { MemoryBackground } from "../../memory/background.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { MemoryError } from "../../memory/schema.js";
import { pickContent } from "../../memory/repository.js";
export function registerMemoryRoutes(
  app: FastifyInstance,
  memory: MemoryService,
  background: MemoryBackground,
  sessions: NodeSessionService,
  secret?: string,
) {
  const getContext = async (req: FastifyRequest) => {
    const q = req.query as Record<string, string>;
    if (req.url.split("?")[0]?.startsWith("/api/memory/agent/")) {
      const grant = verifyMemoryGrant(req.headers["x-memory-grant"], secret);
      const registration = await new AgentSessionRegistry().get(
        grant.cwd,
        grant.sessionId,
      );
      if (
        registration?.parentSessionId ||
        (registration?.purpose && registration.purpose !== "conversation")
      )
        throw new MemoryError(403, "Delegated Memory capability denied");
      if (!(await sessions.exists(grant.sessionId, grant.cwd)))
        throw new MemoryError(404, "Main session not found");
      return memory.context(grant.cwd, "agent", grant.sessionId);
    }
    if (req.url.split("?")[0] === "/api/memory/settings" && !q.cwd)
      return {
        cwd: "",
        context: {
          ownerId: LOCAL_OWNER,
          projectId: "",
          actor: "user" as const,
        },
      };
    return memory.context(q.cwd ?? ".", "user", q.sessionId);
  };
  const route = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    handler: (
      request: FastifyRequest,
      ctx: Awaited<ReturnType<typeof getContext>>,
    ) => Promise<unknown>,
  ) =>
    app.route({
      method,
      url: "/api/memory" + path,
      handler: async (request, reply) => {
        try {
          return await handler(request, await getContext(request));
        } catch (e) {
          if (e instanceof ZodError)
            return reply
              .code(400)
              .send({ error: e.issues.map((i) => i.message).join("; ") });
          const err = e as Error & { statusCode?: number };
          if (err.statusCode)
            return reply.code(err.statusCode).send({ error: err.message });
          throw e;
        }
      },
    });
  const body = (req: FastifyRequest) =>
    (req.body ?? {}) as Record<string, unknown>;
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  route("GET", "/summary", async (_, ctx) => {
    const { total } = await memory.command(ctx.context, "browse", {
      pageSize: 1,
    });
    const reviews = await memory.command(ctx.context, "reviews");
    return {
      count: total,
      pendingCount: reviews.records.length + reviews.proposals.length,
      enabled: (await memory.command(ctx.context, "settings")).enabled,
    };
  });
  route("GET", "/records", async (req, ctx) =>
    memory.command(ctx.context, "browse", req.query as Record<string, unknown>),
  );
  route("GET", "/records/:id", async (req, ctx) =>
    memory.command(ctx.context, "read", { id: id(req) }),
  );
  route("POST", "/records", async (req, ctx) =>
    memory.command(ctx.context, "write", {
      ...body(req),
      operation: "append",
      content: await memory.validateContent(
        ctx.cwd,
        ctx.context,
        body(req).content,
      ),
    }),
  );
  route("PATCH", "/records/:id", async (req, ctx) =>
    memory.command(ctx.context, "write", {
      ...body(req),
      id: id(req),
      operation: "replace",
      content: await memory.validateContent(
        ctx.cwd,
        ctx.context,
        body(req).content,
      ),
    }),
  );
  route("POST", "/records/:id/archive", async (req, ctx) =>
    memory.command(ctx.context, "write", {
      ...body(req),
      id: id(req),
      operation: "remove",
    }),
  );
  route("DELETE", "/records/:id", async (req, ctx) =>
    memory.command(ctx.context, "delete", { ...body(req), id: id(req) }),
  );
  route("GET", "/records/:id/history", async (req, ctx) =>
    memory.command(ctx.context, "history", { id: id(req) }),
  );
  for (const action of ["approve", "reject"] as const)
    route("POST", "/records/:id/" + action, async (req, ctx) => {
      if (action === "approve") {
        const current = (
          await memory.command(ctx.context, "read", { id: id(req) })
        ).record;
        await memory.validateContent(
          ctx.cwd,
          ctx.context,
          pickContent(current),
          {requirePinnedMemory:true},
        );
      }
      return memory.command(ctx.context, action, { ...body(req), id: id(req) });
    });
  route("GET", "/reviews", async (_, ctx) =>
    memory.command(ctx.context, "reviews"),
  );
  route("GET", "/dream/proposals", async (_, ctx) => ({
    proposals: (await memory.command(ctx.context, "reviews")).proposals,
  }));
  for (const action of ["accept", "reject"] as const)
    route("POST", "/dream/proposals/:id/" + action, async (req, ctx) => {
      if (action === "accept") {
        const proposals = (await memory.command(ctx.context, "reviews"))
          .proposals;
        const proposal = proposals.find(
          (p: { id: string }) => p.id === id(req),
        );
        if (!proposal) throw new MemoryError(404, "Proposal not found");
        await memory.validateContent(
          ctx.cwd,
          ctx.context,
          pickContent(proposal.candidate),
          {requirePinnedMemory:true},
        );
      }
      return memory.command(
        ctx.context,
        action === "accept" ? "approve" : "reject",
        { ...body(req), proposalId: id(req) },
      );
    });
  route("GET", "/settings", async (_, ctx) => {
    if (ctx.cwd) await memory.command(ctx.context, "touch", { cwd: ctx.cwd });
    return memory.command(ctx.context, "settings");
  });
  route("PATCH", "/settings", async (req, ctx) => {
    if (ctx.cwd) await memory.command(ctx.context, "touch", { cwd: ctx.cwd });
    return memory.command(ctx.context, "settings.update", body(req));
  });
  route("GET", "/project-settings", async (_, ctx) =>
    memory.command(ctx.context, "project.settings"),
  );
  route("PATCH", "/project-settings", async (req, ctx) =>
    memory.command(ctx.context, "project.settings.update", body(req)),
  );
  route("GET", "/categories", async (_, ctx) =>
    memory.command(ctx.context, "categories"),
  );
  route("POST", "/categories", async (req, ctx) =>
    memory.command(ctx.context, "category.write", body(req)),
  );
  route("GET", "/background-runs", async (_, ctx) =>
    memory.command(ctx.context, "runs"),
  );
  route("POST", "/dream/run", async (req, ctx) => {
    const b = body(req);
    return background.enqueue(ctx.context, ctx.cwd, "dream", {
      forceScan: b.forceScan === true,
      confirmedForceScan: b.confirmedForceScan === true,
    });
  });
  route("POST", "/extraction/run", async (req, ctx) => {
    const sessionId = String(body(req).sessionId ?? "");
    const bound = await memory.context(ctx.cwd, "user", sessionId);
    await memory.command(bound.context, "touch", { cwd: ctx.cwd });
    return background.enqueue(bound.context, ctx.cwd, "extraction", {
      sessionId,
    });
  });
  route("POST", "/dream/runs/:id/cancel", async (req, ctx) =>
    memory.command(ctx.context, "run.cancel", { id: id(req) }),
  );
  route("POST", "/background-runs/:id/retry", async (req, ctx) =>
    background.retry(ctx.context, ctx.cwd, id(req)),
  );
  route("GET", "/export", async (_, ctx) =>
    memory.command(ctx.context, "export"),
  );
  route("POST", "/agent/search", async (req, ctx) =>
    memory.command(ctx.context, "agent.search", body(req)),
  );
  route("POST", "/agent/read", async (req, ctx) =>
    memory.command(ctx.context, "read", body(req)),
  );
  route("POST", "/agent/recall", async (req, ctx) =>
    memory.recall(ctx.cwd, ctx.context, body(req)),
  );
  route("POST", "/agent/write", async (req, ctx) => {
    const b = body(req);
    if (b.operation !== "remove")
      b.content = await memory.validateContent(ctx.cwd, ctx.context, b.content);
    return memory.command(ctx.context, "write", b);
  });
}
