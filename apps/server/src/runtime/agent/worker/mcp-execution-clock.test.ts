import { afterEach, expect, it, vi } from "vitest";
import { McpExecutionClock } from "./mcp-execution-clock.js";

afterEach(() => vi.useRealTimers());
it("excludes slow approvals from the owning connection while other requests still expire", async () => {
  vi.useFakeTimers();
  const clock = new McpExecutionClock();
  let done!: (value: string) => void;
  const owner = clock.run(
    "owner",
    clock.activeNow("owner") + 60_000,
    "expired",
    () =>
      new Promise<string>((resolve) => {
        done = resolve;
      }),
  );
  const other = clock.run(
    "other",
    clock.activeNow("other") + 10_000,
    "expired",
    () => new Promise(() => {}),
  );
  const failed = expect(other).rejects.toThrow("expired");
  await vi.advanceTimersByTimeAsync(1000);
  const leave = clock.beginApproval("owner");
  await vi.advanceTimersByTimeAsync(90_000);
  await failed;
  leave();
  await vi.advanceTimersByTimeAsync(58_000);
  done("approved");
  expect(await owner).toBe("approved");
});
it("resumes the remaining execution budget rather than resetting it", async () => {
  vi.useFakeTimers();
  const clock = new McpExecutionClock();
  const result = clock.run(
    "owner",
    clock.activeNow("owner") + 10_000,
    "expired",
    () => new Promise(() => {}),
  );
  const failed = expect(result).rejects.toThrow("expired");
  await vi.advanceTimersByTimeAsync(9000);
  const leave = clock.beginApproval("owner");
  await vi.advanceTimersByTimeAsync(110_000);
  leave();
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
});
it("honors cancellation during approval and accounts overlapping waits once", async () => {
  vi.useFakeTimers();
  const clock = new McpExecutionClock(),
    controller = new AbortController();
  const start = clock.activeNow("owner");
  const result = clock.run(
    "owner",
    start + 10_000,
    "expired",
    () => new Promise(() => {}),
    controller.signal,
  );
  const failed = expect(result).rejects.toThrow("cancelled");
  const one = clock.beginApproval("owner"),
    two = clock.beginApproval("owner");
  await vi.advanceTimersByTimeAsync(5000);
  one();
  await vi.advanceTimersByTimeAsync(5000);
  two();
  expect(clock.activeNow("owner")).toBe(start);
  controller.abort(new Error("cancelled"));
  await failed;
});
it("does not start work after an expired deadline or preexisting cancellation", async () => {
  const clock = new McpExecutionClock(),
    execute = vi.fn(async () => "unexpected");
  await expect(
    clock.run("expired", clock.activeNow("expired"), "expired", execute),
  ).rejects.toThrow("expired");
  await expect(
    clock.run(
      "cancelled",
      clock.activeNow("cancelled") + 1000,
      "expired",
      execute,
      AbortSignal.abort(new Error("cancelled")),
    ),
  ).rejects.toThrow("cancelled");
  expect(execute).not.toHaveBeenCalled();
});
it("cancels an outstanding authorization when its RPC is aborted or completes", async () => {
  const clock = new McpExecutionClock(),
    controller = new AbortController();
  let finish!: () => void;
  const running = clock.run(
    "rpc",
    clock.activeNow("rpc") + 1000,
    "expired",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    controller.signal,
  );
  await Promise.resolve();
  const signal = clock.approvalSignal("rpc", new AbortController().signal);
  finish();
  await running;
  expect(signal.aborted).toBe(true);
  const other = clock.run(
    "cancel",
    clock.activeNow("cancel") + 1000,
    "expired",
    () => new Promise(() => {}),
    controller.signal,
  );
  const failed = expect(other).rejects.toThrow("cancelled");
  const cancelled = clock.approvalSignal("cancel", new AbortController().signal);
  controller.abort(new Error("cancelled"));
  await failed;
  expect(cancelled.aborted).toBe(true);
});
