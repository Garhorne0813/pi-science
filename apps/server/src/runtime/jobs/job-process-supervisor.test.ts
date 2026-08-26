import { describe, expect, it } from "vitest";
import { ProcessSupervisor } from "./job-process-supervisor.js";

describe("process supervisor", () => {
  it("owns output capture and returns a bounded process result", async () => {
    const supervisor = new ProcessSupervisor();
    const spawned = supervisor.spawn(
      "output-job",
      [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err')"],
      process.cwd(),
      { ...process.env },
      2_000,
    );

    const result = await spawned.result;
    expect(result).toMatchObject({ code: 0, stdout: "out", stderr: "err", timed_out: false, stdout_truncated: false, stderr_truncated: false });
    supervisor.forget("output-job");
  });

  it("terminates a process that exceeds its deadline", async () => {
    const supervisor = new ProcessSupervisor();
    const spawned = supervisor.spawn(
      "timeout-job",
      [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      process.cwd(),
      { ...process.env },
      50,
    );

    const result = await spawned.result;
    expect(result.timed_out).toBe(true);
    supervisor.forget("timeout-job");
  });
});
