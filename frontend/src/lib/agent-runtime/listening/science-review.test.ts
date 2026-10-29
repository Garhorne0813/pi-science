import { afterEach, describe, expect, it, vi } from "vitest";
import { listenerBinding } from "./binding";
import { maybeRequestScienceReview } from "./science-review";

afterEach(() => {
  listenerBinding.client = null;
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("maybeRequestScienceReview", () => {
  it("handles a rejected request without leaving an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", record);
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    listenerBinding.client = { requestScienceReview: vi.fn(async () => { throw new Error("409 science review already running"); }) } as never;
    try {
      maybeRequestScienceReview("rejected", "/workspace");
      await settle();
      await settle();
      expect(rejections).toEqual([]);
      expect(logged).toHaveBeenCalled();
    } finally { process.off("unhandledRejection", record); }
  });

  it("keeps the turn alive when the client throws before returning a promise", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.fn()
      .mockImplementationOnce(() => { throw new Error("client is not ready"); })
      .mockResolvedValueOnce(undefined);
    listenerBinding.client = { requestScienceReview: request } as never;
    expect(() => maybeRequestScienceReview("throwing", "/workspace")).not.toThrow();
    expect(logged).toHaveBeenCalled();
    // A failure before the promise exists must not pin the guard forever.
    maybeRequestScienceReview("throwing", "/workspace");
    expect(request).toHaveBeenCalledTimes(2);
    await settle();
  });

  it("deduplicates one in-flight review per workspace session", async () => {
    let finish: (() => void) | null = null;
    const request = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    listenerBinding.client = { requestScienceReview: request } as never;
    maybeRequestScienceReview("pending", "/workspace");
    maybeRequestScienceReview("pending", "/workspace");
    expect(request).toHaveBeenCalledTimes(1);
    finish!();
    await settle();
    maybeRequestScienceReview("pending", "/workspace");
    expect(request).toHaveBeenCalledTimes(2);
    finish!();
    await settle();
  });

  it("ignores a turn without a bound client or workspace", () => {
    listenerBinding.client = null;
    expect(() => maybeRequestScienceReview("idle", "/workspace")).not.toThrow();
    listenerBinding.client = { requestScienceReview: vi.fn() } as never;
    expect(() => maybeRequestScienceReview("idle", undefined)).not.toThrow();
  });
});
