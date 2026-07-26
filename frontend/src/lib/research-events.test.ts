import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeResearchEvents } from "./research-events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  message(): void {
    this.onmessage?.({ data: JSON.stringify({ type: "research.record" }) } as MessageEvent);
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

describe("subscribeResearchEvents", () => {
  it("collapses a burst of messages into a single trailing signal per 500ms window", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeResearchEvents("/workspace/demo", onSignal);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`/api/project-memory/research-events?cwd=${encodeURIComponent("/workspace/demo")}`);

    source.message();
    source.message();
    source.message();
    expect(onSignal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(onSignal).toHaveBeenCalledTimes(1);

    source.message();
    vi.advanceTimersByTime(499);
    expect(onSignal).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onSignal).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("signals on open so reconnects catch up on missed events", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeResearchEvents(".", onSignal);
    const source = FakeEventSource.instances[0]!;

    source.onopen?.({} as Event);
    vi.advanceTimersByTime(500);
    expect(onSignal).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("closes the source and drops the pending signal on cleanup", () => {
    const onSignal = vi.fn();
    const cleanup = subscribeResearchEvents(".", onSignal);
    const source = FakeEventSource.instances[0]!;

    source.message();
    cleanup();
    expect(source.closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(onSignal).not.toHaveBeenCalled();
  });
});
