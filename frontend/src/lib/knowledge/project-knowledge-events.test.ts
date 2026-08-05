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
});

describe("subscribeProjectKnowledgeEvents", () => {
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
});
