/** Shared fixtures for the client tests: a scriptable EventSource plus the
 *  localStorage stub the name registry and message cache need in jsdom. */

import { afterEach, beforeEach, vi } from "vitest";

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private handlers = new Map<string, Array<(event: { data?: string; lastEventId?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const callback = typeof handler === "function"
      ? handler as unknown as (event: { data?: string; lastEventId?: string }) => void
      : (event: { data?: string; lastEventId?: string }) => handler.handleEvent(event as unknown as Event);
    this.handlers.set(type, [...(this.handlers.get(type) || []), callback]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({} as Event);
  }

  emit(type: string, payload: unknown, lastEventId?: string): void {
    const event = { data: JSON.stringify(payload), lastEventId };
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}

export function installClientTestEnvironment(): void {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    // Provide a minimal localStorage mock so message cache tests work in jsdom.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
      get length() { return store.size; },
      key: (index: number) => [...store.keys()][index] ?? null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
