import { applicationErrorStatus } from "../application-error.js";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  jobListQuerySchema,
  jobParamsSchema,
  jobRequirementSchema,
  jobSubmitRequestSchema,
  type ApiErrorResponse,
} from "@pi-science/contracts";
import {
  JobCoordinator,
  JobRequestError,
  publicJobRecord,
} from "../../runtime/jobs/job-coordinator.js";
import { validateWorkspaceCwd } from "../../security/workspace-security.js";

function failure(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  fields?: string[],
) {
  const body: ApiErrorResponse = {
    error: { code, message, ...(fields ? { fields } : {}) },
    request_id: request.id,
  };
  return reply.code(status).send(body);
}
async function workspace(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const query = request.query as Record<string, unknown>;
  if (query.cwd !== undefined && typeof query.cwd !== "string") {
    failure(request, reply, 400, "invalid_request", "cwd must be a string", ["cwd"]);
    return null;
  }
  try {
    return await validateWorkspaceCwd(typeof query.cwd === "string" && query.cwd ? query.cwd : ".");
  } catch (error) {
    failure(request, reply, 403, "workspace_invalid", String(error));
    return null;
  }
}

export function registerJobRoutes(app: FastifyInstance, jobs: JobCoordinator): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    request.log.error({ err: error }, "Job request failed");
    return failure(
      request,
      reply,
      status,
      status >= 500 ? "internal_error" : status === 429 ? "rate_limited" : "invalid_request",
      status >= 500 ? "internal server error" : error.message,
    );
  });
  app.post(
    "/api/jobs/capabilities",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = jobRequirementSchema.safeParse(request.body ?? {});
      if (!parsed.success)
        return failure(
          request,
          reply,
          400,
          "invalid_request",
          "Invalid job requirement",
          parsed.error.issues.map((issue) => issue.path.join(".")),
        );
      const query = request.query as Record<string, unknown>;
      if (query.cwd !== undefined) {
        const cwd = await workspace(request, reply);
        if (!cwd) return;
        return jobs.capabilitiesForWorkspace(cwd, parsed.data);
      }
      return jobs.capabilities(parsed.data);
    },
  );
  app.post(
    "/api/jobs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = jobSubmitRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return failure(
          request,
          reply,
          400,
          "invalid_request",
          "Invalid job request",
          parsed.error.issues.map((issue) => issue.path.join(".")),
        );
      const headerKey = request.headers["idempotency-key"];
      if (
        headerKey !== undefined &&
        (typeof headerKey !== "string" ||
          !headerKey.length ||
          headerKey.length > 200 ||
          (parsed.data.idempotency_key && parsed.data.idempotency_key !== headerKey))
      ) {
        return failure(
          request,
          reply,
          400,
          "invalid_request",
          "Invalid or conflicting Idempotency-Key",
          ["idempotency_key"],
        );
      }
      const cwd = await workspace(request, reply);
      if (!cwd) return;
      try {
        const record = await jobs.submit(cwd, {
          ...parsed.data,
          ...(headerKey ? { idempotency_key: headerKey } : {}),
        });
        return reply
          .code(202)
          .header("location", `/api/jobs/${record.job_id}?cwd=${encodeURIComponent(cwd)}`)
          .send(publicJobRecord(record));
      } catch (error) {
        if (error instanceof JobRequestError)
          return failure(request, reply, applicationErrorStatus(error), error.code, error.message);
        throw error;
      }
    },
  );
  app.get("/api/jobs", async (request, reply) => {
    const parsed = jobListQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return failure(
        request,
        reply,
        400,
        "invalid_request",
        "limit must be an integer from 1 to 1000",
        ["limit"],
      );
    const cwd = await workspace(request, reply);
    if (cwd) return { jobs: (await jobs.list(cwd, parsed.data.limit)).map(publicJobRecord) };
  });
  const handle =
    (operation: "get" | "cancel" | "logs") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = jobParamsSchema.safeParse(request.params);
      if (!parsed.success)
        return failure(request, reply, 400, "invalid_request", "Invalid job id", ["job_id"]);
      const cwd = await workspace(request, reply);
      if (!cwd) return;
      const record = await jobs[operation](cwd, parsed.data.job_id);
      if (!record) return failure(request, reply, 404, "not_found", "Job not found");
      return operation === "logs"
        ? record
        : publicJobRecord(record as Awaited<ReturnType<JobCoordinator["submit"]>>);
    };
  app.get("/api/jobs/:job_id", handle("get"));
  app.post("/api/jobs/:job_id/cancel", handle("cancel"));
  // Compatibility alias: this has always cancelled rather than deleted history.
  app.delete("/api/jobs/:job_id", handle("cancel"));
  app.get("/api/jobs/:job_id/logs", handle("logs"));
}
