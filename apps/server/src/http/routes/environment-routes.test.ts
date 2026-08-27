import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentService } from "../../runtime/workspace/workspace-environment.js";
import { registerEnvironmentRoutes } from "./environment-routes.js";

function service(deleteRevision: ReturnType<typeof vi.fn>): WorkspaceEnvironmentService {
  return {
    deleteRevision,
    list: vi.fn(),
    listPresets: vi.fn(),
    create: vi.fn(),
    status: vi.fn(),
    nodeStatus: vi.fn(),
    ensure: vi.fn(),
    bind: vi.fn(),
    installPackages: vi.fn(),
    rollback: vi.fn(),
  } as unknown as WorkspaceEnvironmentService;
}

describe("environment routes", () => {
  it("deletes failed revisions and returns not found for unknown ids", async () => {
    const remove = vi.fn()
      .mockResolvedValueOnce({ revision_id: "rev_failed" })
      .mockResolvedValueOnce(null);
    const app = Fastify({ logger: false });
    registerEnvironmentRoutes(app, service(remove));

    const deleted = await app.inject({ method: "DELETE", url: "/api/environments/rev_failed" });
    const missing = await app.inject({ method: "DELETE", url: "/api/environments/missing" });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, revision_id: "rev_failed" });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects deleting a ready revision", async () => {
    const error = Object.assign(new Error("Only failed or archived environment revisions can be deleted: rev_ready"), { code: "environment_not_deletable" });
    const app = Fastify({ logger: false });
    registerEnvironmentRoutes(app, service(vi.fn().mockRejectedValue(error)));

    const response = await app.inject({ method: "DELETE", url: "/api/environments/rev_ready" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Only failed or archived");
  });
});
