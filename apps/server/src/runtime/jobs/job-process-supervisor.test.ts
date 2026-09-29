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

  it("returns ordered output deltas without replaying earlier chunks", async () => {
    const supervisor = new ProcessSupervisor();
    const spawned = supervisor.spawn("stream-job", [process.execPath, "-e", "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 150)"], process.cwd(), { ...process.env }, 2_000);
    try {
      let first = supervisor.outputSince("stream-job", 0)!;
      for (let attempt = 0; attempt < 20 && first.frames.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        first = supervisor.outputSince("stream-job", 0)!;
      }
      expect(first.frames.map((frame) => Buffer.from(frame.data, "base64").toString()).join("")).toBe("first");
      await spawned.result;
      const second = supervisor.outputSince("stream-job", first.cursor)!;
      expect(second.frames.map((frame) => Buffer.from(frame.data, "base64").toString()).join("")).toBe("second");
      expect(supervisor.outputSince("stream-job", second.cursor)?.frames).toEqual([]);
    } finally { supervisor.forget("stream-job"); }
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
