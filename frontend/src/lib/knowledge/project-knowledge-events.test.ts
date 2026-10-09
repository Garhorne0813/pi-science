import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeProjectKnowledgeEvents } from "./project-knowledge-events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void { this.closed = true; }

  message(pendingCount: number): void {
    this.onmessage?.({ data: JSON.stringify({ type: "project-knowledge.changed", pending_count: pendingCount }) } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("subscribeProjectKnowledgeEvents", () => {
  it("closes while hidden and refreshes after the tab becomes visible", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const first = FakeEventSource.instances[0]!;

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.closed).toBe(true);
    first.message(9);
    vi.advanceTimersByTime(250);
    expect(onSignal).not.toHaveBeenCalled();

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenCalledWith(undefined);
    cleanup();
  });

  it("catches up when the first source is hidden before OPEN", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const first = FakeEventSource.instances[0]!;

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(first.closed).toBe(true);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    const resumed = FakeEventSource.instances[1]!;

    // Resume refresh may complete before the replacement stream is open.
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenCalledOnce();
    resumed.onopen?.();
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it.each([false, true])("prioritizes catch-up over buffered and resumed counts (delayed OPEN: %s)", (delayedOpen) => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.message(1);
    vi.advanceTimersByTime(100);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    const resumed = FakeEventSource.instances[1]!;
    if (!delayedOpen) resumed.onopen?.();
    resumed.message(2);
    vi.advanceTimersByTime(150);
    expect(onSignal).toHaveBeenCalledExactlyOnceWith(undefined);

    if (delayedOpen) {
      resumed.onopen?.();
      resumed.message(3);
      vi.advanceTimersByTime(250);
      expect(onSignal).toHaveBeenLastCalledWith(undefined);
    }
    // The next normal window can use SSE counts again.
    resumed.message(4);
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenLastCalledWith({ type: "project-knowledge.changed", pending_count: 4 });
    cleanup();
  });

  it("prioritizes a native reconnect over a buffered count", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const source = FakeEventSource.instances[0]!;
    source.onopen?.();
    source.message(1);
    source.onopen?.();
    source.message(2);
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenCalledExactlyOnceWith(undefined);
    cleanup();
  });

  it("debounces a burst and keeps the latest pending count", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents("/workspace/demo", onSignal);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`/api/project-knowledge/events?cwd=${encodeURIComponent("/workspace/demo")}`);

    source.message(1);
    source.message(2);
    vi.advanceTimersByTime(249);
    expect(onSignal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onSignal).toHaveBeenCalledOnce();
    expect(onSignal).toHaveBeenCalledWith({ type: "project-knowledge.changed", pending_count: 2 });
    cleanup();
  });

  it("skips the initial open but signals after a reconnect", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const source = FakeEventSource.instances[0]!;
    source.onopen?.();
    vi.advanceTimersByTime(250);
    expect(onSignal).not.toHaveBeenCalled();

    source.onopen?.();
    vi.advanceTimersByTime(250);

    expect(onSignal).toHaveBeenCalledOnce();
    expect(onSignal).toHaveBeenCalledWith(undefined);
    cleanup();
  });

  it("closes the stream and cancels a pending signal", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const source = FakeEventSource.instances[0]!;
    source.message(1);
    cleanup();
    vi.advanceTimersByTime(1_000);

    expect(source.closed).toBe(true);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps resume catch-up authoritative with a later count=%s", (laterCount) => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.message(1);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    const resumed = FakeEventSource.instances[1]!;
    resumed.onopen?.();
    if (laterCount) resumed.message(9);
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenCalledExactlyOnceWith(undefined);
    // The next ordinary window can use fresh events again.
    resumed.message(2);
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenLastCalledWith({ type: "project-knowledge.changed", pending_count: 2 });
    cleanup();
  });

  it("prioritizes reconnect catch-up over an already buffered count", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeProjectKnowledgeEvents(".", onSignal);
    const source = FakeEventSource.instances[0]!;
    source.onopen?.();
    source.message(1);
    source.onopen?.();
    source.message(9);
    vi.advanceTimersByTime(250);
    expect(onSignal).toHaveBeenCalledExactlyOnceWith(undefined);
    cleanup();
  });

});
