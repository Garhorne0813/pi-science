import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../client/query-client";
import { runsKey } from "./runs";
import { subscribeExecutionInvalidation } from "./execution-events";

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
  message(): void { this.onmessage?.({ data: JSON.stringify({ event_type: "execution.started" }) } as MessageEvent); }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("subscribeExecutionInvalidation", () => {
  it("debounces execution events and invalidates the workspace ledger", () => {
    const key = runsKey("/workspace/demo");
    queryClient.setQueryData(key, []);
    const cleanup = subscribeExecutionInvalidation("/workspace/demo");
    const source = FakeEventSource.instances[0]!;

    expect(source.url).toBe(`/api/executions/events?cwd=${encodeURIComponent("/workspace/demo")}`);
    source.message();
    source.message();
    vi.advanceTimersByTime(149);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    cleanup();
  });

  it("reports connection changes and catches up after reconnecting", () => {
    const onConnectionChange = vi.fn();
    const cleanup = subscribeExecutionInvalidation(".", { onConnectionChange });
    const source = FakeEventSource.instances[0]!;

    source.onopen?.();
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);
    source.onerror?.({} as Event);
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);
    source.onopen?.();
    vi.advanceTimersByTime(150);
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);
    cleanup();
    expect(source.closed).toBe(true);
  });
});
