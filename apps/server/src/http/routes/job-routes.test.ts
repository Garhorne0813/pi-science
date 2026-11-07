import Fastify from "fastify";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerJobRoutes } from "./job-routes.js";
import type { JobCoordinator } from "../../runtime/jobs/job-coordinator.js";

describe("job HTTP boundary", () => {
  it("validates input, preserves storage failures, and exposes asynchronous cancellation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-job-http-"));
    await mkdir(join(cwd, ".pi-science"));
    const app = Fastify();
    const record = { job_id: "job_0123456789abcdef", command: ["true"], status: "pending" };
    const jobs = {
      submit: vi.fn().mockResolvedValue(record),
      list: vi.fn().mockResolvedValue([]),
      cancel: vi.fn().mockResolvedValue(record),
    };
    registerJobRoutes(app, jobs as unknown as JobCoordinator);
    const url = `/api/jobs?cwd=${encodeURIComponent(cwd)}`;
    try {
      for (const limit of ["abc", "NaN", "1.5", "0", "1001"]) {
        const result = await app.inject({ method: "GET", url: `${url}&limit=${limit}` });
        expect(result.statusCode).toBe(400);
        expect(result.json()).toMatchObject({
          error: { code: "invalid_request", fields: ["limit"] },
          request_id: expect.any(String),
        });
      }
      expect(jobs.list).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: "POST", url, payload: { command: [42] } })).statusCode,
      ).toBe(400);
      expect(jobs.submit).not.toHaveBeenCalled();
      const submitted = await app.inject({
        method: "POST",
        url,
        headers: { "idempotency-key": "retry-1" },
        payload: { command: ["true"] },
      });
      expect(submitted.statusCode).toBe(202);
      expect(submitted.headers.location).toContain(`/api/jobs/${record.job_id}`);
      expect(jobs.submit).toHaveBeenCalledWith(expect.any(String), {
        command: ["true"],
        idempotency_key: "retry-1",
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/jobs/${record.job_id}/cancel?cwd=${encodeURIComponent(cwd)}`,
          })
        ).statusCode,
      ).toBe(200);
      jobs.submit.mockRejectedValue(new Error("disk failure"));
      expect(
        (await app.inject({ method: "POST", url, payload: { command: ["true"] } })).statusCode,
      ).toBe(500);
    } finally {
      await app.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
