import { describe, expect, it } from "vitest";
import { canTransitionJobStatus, transitionJobStatus, type JobRecord } from "./job-types.js";

const record = (status: JobRecord["status"]): JobRecord => ({
  job_id: "job_test0000000000",
  command: ["node"],
  cwd: "/workspace",
  surface: "local",
  status,
  created_at: new Date(0).toISOString(),
  stdout: "",
  stderr: "",
  artifact_ids: [],
  environment: {},
  requirement: {},
});

describe("job lifecycle state machine", () => {
  it("allows only lifecycle transitions owned by the job domain", () => {
    expect(canTransitionJobStatus("pending", "running")).toBe(true);
    expect(canTransitionJobStatus("running", "timed_out")).toBe(true);
    expect(canTransitionJobStatus("pending", "succeeded")).toBe(false);
    expect(canTransitionJobStatus("succeeded", "running")).toBe(false);
  });

  it("rejects terminal rewrites and preserves the record shape", () => {
    expect(transitionJobStatus(record("pending"), "running")).toMatchObject({ status: "running", job_id: "job_test0000000000" });
    expect(() => transitionJobStatus(record("succeeded"), "failed")).toThrow("invalid job status transition");
  });
});
