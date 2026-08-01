/** Shared fixtures for the runtime store tests: a scriptable EventSource, JSON
 *  response builders and the per-test environment reset. */

import { afterEach, beforeEach, vi } from "vitest";

import { createClient } from "../client/pi-science-client";
import { useRuntimeStore } from "./index";

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  private handlers = new Map<string, Array<(event: { data?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
    const callback = typeof handler === "function"
      ? handler as unknown as (event: { data?: string }) => void
      : (event: { data?: string }) => handler.handleEvent(event as unknown as Event);
    this.handlers.set(type, [...(this.handlers.get(type) || []), callback]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({} as Event);
  }

  emit(type: string, payload: unknown): void {
    const event = { data: JSON.stringify(payload) };
    for (const handler of this.handlers.get(type) || []) handler(event);
  }
}


export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function state(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    id: sessionId,
    cwd: "/workspace",
    is_streaming: false,
    is_compacting: false,
    pending_message_count: 0,
    model: "custom-custom-api/gpt-5.6-luna",
    thinking: "max",
    context_tokens: 24000,
    context_window: 128000,
    context_percent: 18.75,
    compaction_enabled: true,
    compaction_threshold_percent: 85,
    ...overrides,
  };
}

/** Register the beforeEach/afterEach hooks every runtime store test file uses:
 *  a fake EventSource and localStorage, a fresh client, and a store reset. */
export function installRuntimeTestEnvironment(): void {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    createClient("");
    useRuntimeStore.setState({
      status: "offline",
      client: null,
      sessions: [],
      activeSessionId: null,
      cwd: ".",
      thread: { blocks: [], index: {}, loaded: false },
      working: false,
      model: null,
      thinking: null,
      contextTokens: null,
      contextWindow: null,
      contextPercent: null,
      compactionEnabled: true,
      compactionThresholdPercent: null,
      pendingInteraction: null,
      fileRevision: 0,
      draft: "",
    });
  });

  afterEach(() => {
    useRuntimeStore.getState().disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
