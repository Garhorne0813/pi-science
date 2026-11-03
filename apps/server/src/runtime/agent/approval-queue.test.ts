import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./approval-queue.js";
import { ApprovalBridge } from "./worker/approval-bridge.js";
import type { WorkerEvent } from "./worker/protocol.js";

describe("approval admission", () => {
  it("orders one target without blocking unrelated targets or sharing a decision", async () => {
    const queue = new ApprovalQueue();
    const first = await queue.acquire("tool-a");
    const entered = vi.fn();
    const next = queue.acquire("tool-a").then(release => { entered(); return release; });
    const other = await queue.acquire("tool-b");
    expect(entered).not.toHaveBeenCalled();
    other(); first();
    const release = await next;
    expect(entered).toHaveBeenCalledOnce();
    first(); release();
    (await queue.acquire("tool-a"))();
  });

  it("removes a cancelled waiter while preserving the remaining order", async () => {
    const queue = new ApprovalQueue(), abort = new AbortController();
    const first = await queue.acquire("target");
    const cancelled = queue.acquire("target", abort.signal);
    const failure = expect(cancelled).rejects.toThrow("cancelled");
    const next = queue.acquire("target");
    abort.abort(new Error("cancelled")); await failure;
    first(); (await next)();
    (await queue.acquire("target"))();
  });

  it("retains a service commit after the worker releases its lease", async () => {
    const queue = new ApprovalQueue();
    const first = await queue.acquire("saving");
    const finishSave = queue.hold("saving");
    const entered = vi.fn();
    const second = queue.acquire("saving").then(release => { entered(); return release; });
    first(); await Promise.resolve();
    expect(entered).not.toHaveBeenCalled();
    finishSave(); (await second)(); finishSave();
    (await queue.acquire("saving"))();
  });

  it("releases a worker IPC lease on cancellation and ignores late grants", async () => {
    const events: WorkerEvent[] = [], abort = new AbortController();
    const bridge = new ApprovalBridge(event => events.push(event));
    const pending = bridge.acquire("target", abort.signal);
    const id = (events[0] as Extract<WorkerEvent, { type: "approval_acquire" }>).id;
    const failure = expect(pending).rejects.toThrow("cancelled");
    abort.abort(new Error("cancelled")); await failure;
    bridge.grant(id);
    expect(events).toEqual([{ type: "approval_acquire", id, key: "target" }, { type: "approval_release", id }]);
  });
});
