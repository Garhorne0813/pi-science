import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openJsonEventStream } from "./event-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  close(): void { this.closed = true; }
  open(): void { this.onopen?.({} as Event); }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("openJsonEventStream visibility recovery", () => {
  it("marks the replacement open as resumed when the first source never opened", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onOpen = vi.fn();
    const onResume = vi.fn();
    const cleanup = openJsonEventStream("/events", {
      onMessage: vi.fn(),
      onOpen,
      onResume,
      pauseWhenHidden: true,
    });
    const connecting = FakeEventSource.instances[0]!;
    expect(FakeEventSource.instances).toHaveLength(1);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(connecting.closed).toBe(true);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));

    expect(onResume).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.open();
    expect(onOpen).toHaveBeenCalledWith({ resumed: true, reconnect: false });
    cleanup();
  });

  it("does not reopen after cleanup when the tab becomes visible", () => {
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onResume = vi.fn();
    const cleanup = openJsonEventStream("/events", { onMessage: vi.fn(), onResume, pauseWhenHidden: true });
    expect(FakeEventSource.instances).toHaveLength(0);
    cleanup();

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("keeps one source through repeated hide and resume cycles", () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const onOpen = vi.fn();
    const cleanup = openJsonEventStream("/events", { onMessage: vi.fn(), onOpen, pauseWhenHidden: true });
    FakeEventSource.instances[0]!.open();

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    const resumed = FakeEventSource.instances[1]!;
    resumed.open();
    expect(onOpen).toHaveBeenLastCalledWith({ resumed: true, reconnect: true });

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeEventSource.instances).toHaveLength(3);
    cleanup();
    expect(FakeEventSource.instances[2]!.closed).toBe(true);
  });
});
