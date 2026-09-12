import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultProgressAppearance, type ProgressAppearance } from "@pi-science/contracts";
import {
  getProgressSettings,
  hydrateProgressAppearance,
  resetProgressSettingsForTests,
  updateProgressAppearance,
  updateProgressPattern,
} from "./progress-settings-store";

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  body?: unknown;
  url: string;
  method: string;
  keepalive?: boolean;
  settled: boolean;
};
const deferreds: Deferred[] = [];

function appearanceWith(patch: Partial<ProgressAppearance>): ProgressAppearance {
  return { ...structuredClone(defaultProgressAppearance), ...patch, patterns: { ...defaultProgressAppearance.patterns, ...(patch.patterns ?? {}) } };
}

function pendingRequests(): Deferred[] {
  return deferreds.filter((deferred) => !deferred.settled);
}

function stubFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    deferreds.push({ resolve, reject, body: init?.body ? JSON.parse(String(init.body)) : undefined, url, method, keepalive: init?.keepalive, settled: false });
    return promise.then((value) => value as Response);
  }));
}

function respond(deferred: Deferred, payload: unknown, ok = true): void {
  deferred.settled = true;
  deferred.resolve(new Response(JSON.stringify(payload), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } }));
}


async function settle(): Promise<void> {
  // Drain enough microtask turns for the save chain (apiRequest → unwrap →
  // invalidateSettings → queue loop) to reach its next observable state.
  for (let round = 0; round < 12; round += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetProgressSettingsForTests();
  deferreds.length = 0;
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("progress settings controller", () => {
  it("lets the newest edit win when an older save receipt lands late", async () => {
    updateProgressAppearance(appearanceWith({ speed: 1.5 }));
    await vi.advanceTimersByTimeAsync(250);
    expect(pendingRequests()).toHaveLength(1);

    // Edit while save A is in flight; B queues behind it.
    updateProgressAppearance(appearanceWith({ speed: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    expect(pendingRequests()).toHaveLength(1);

    const [putA] = deferreds;
    respond(putA, { ok: true, progress_appearance: putA.body });
    await settle();
    // A's receipt (speed 1.5) must not roll back the newer 2.0 draft.
    expect(getProgressSettings().appearance.speed).toBe(2);
    expect(getProgressSettings().dirty).toBe(true);

    // B (the 2.0 snapshot) follows immediately and confirms the final state.
    expect(pendingRequests()).toHaveLength(1);
    respond(pendingRequests()[0], { ok: true, progress_appearance: pendingRequests()[0].body });
    await settle();
    expect(getProgressSettings().appearance.speed).toBe(2);
    expect(getProgressSettings().dirty).toBe(false);
    expect(getProgressSettings().saveError).toBe(false);
  });

  it("keeps the queued draft retrying after a failed save", async () => {
    updateProgressAppearance(appearanceWith({ speed: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    respond(pendingRequests()[0], { error: "boom" }, false);
    await settle();
    expect(getProgressSettings().saveError).toBe(true);
    expect(getProgressSettings().dirty).toBe(true);
    expect(getProgressSettings().appearance.speed).toBe(2);

    // Backoff retry delivers the same draft and clears the failure.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pendingRequests()).toHaveLength(1);
    respond(pendingRequests()[0], { ok: true, progress_appearance: pendingRequests()[0].body });
    await settle();
    expect(getProgressSettings().saveError).toBe(false);
    expect(getProgressSettings().dirty).toBe(false);
    expect(getProgressSettings().appearance.speed).toBe(2);
  });

  it("does not let a late hydration GET roll back local edits", async () => {
    const hydration = hydrateProgressAppearance();
    expect(pendingRequests()[0].method).toBe("GET");
    updateProgressAppearance(appearanceWith({ speed: 2 }));
    respond(pendingRequests()[0], { progress_appearance: appearanceWith({ speed: 1 }) });
    await hydration;
    expect(getProgressSettings().appearance.speed).toBe(2);
    expect(getProgressSettings().dirty).toBe(true);
  });

  it("applies a hydration snapshot when no local edits raced it", async () => {
    const hydration = hydrateProgressAppearance();
    respond(pendingRequests()[0], { progress_appearance: appearanceWith({ speed: 1.5, motion: "full" }) });
    await hydration;
    expect(getProgressSettings().appearance.speed).toBe(1.5);
    expect(getProgressSettings().appearance.motion).toBe("full");
  });

  it("turns a manual pattern edit into a custom preset that survives normalization", () => {
    updateProgressPattern("thinking", "static-check");
    const { appearance } = getProgressSettings();
    expect(appearance.preset).toBe("custom");
    expect(appearance.patterns.thinking).toBe("static-check");
  });

  it("sends the dirty current snapshot with keepalive while its normal save is in flight", async () => {
    updateProgressAppearance(appearanceWith({ speed: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    expect(pendingRequests()).toHaveLength(1);

    window.dispatchEvent(new Event("pagehide"));

    expect(pendingRequests()).toHaveLength(2);
    expect(pendingRequests()[1]).toMatchObject({
      method: "PUT",
      keepalive: true,
      body: expect.objectContaining({ speed: 2 }),
    });
  });
});
