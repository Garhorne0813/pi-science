import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationEventHub } from "../../events/conversation-event-hub.js";
import type { AgentCoreRuntimeClient } from "../agent-runtime-client.js";
import { identity } from "./identity.js";
import { recover } from "./supervision.js";
import type { Live } from "./types.js";

type Context = Parameters<typeof recover>[0];

function recoveryFailures(
  received: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return received.filter((event) => event.code === "worker_recovery_failed");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("worker recovery errors", () => {
  it("keeps failed reopens recoverable until the last attempt ends the turn", async () => {
    const cwd = "/workspace";
    const sessionId = "session-recovery";
    const hub = new ConversationEventHub({
      append: async () => undefined,
      readAfter: async () => [],
    });
    const received: Array<Record<string, unknown>> = [];
    const unsubscribe = await hub.subscribe(cwd, sessionId, undefined, (record) => {
      received.push(JSON.parse(record.data) as Record<string, unknown>);
    });

    const context = {
      events: hub,
      stopping: false,
      live: new Map(),
      recovering: new Map(),
      recoveryAttempts: new Map(),
      recoveryTimers: new Map(),
      manager: { stop: vi.fn(async () => undefined) },
      withMutation: (_cwd: string, _sessionId: string, operation: () => Promise<unknown>) =>
        operation(),
      open: vi.fn(async () => ({ success: false, error: "worker failed to start" })),
    } as unknown as Context;
    // The retry timer re-enters supervision, so the fresh context has to route
    // back into the same recover implementation instead of a stub.
    (context as unknown as { recover: (item: Live, force?: boolean) => Promise<void> }).recover = (
      item,
      force,
    ) => recover(context, item, force);

    const runtime = {
      cwd,
      sessionId,
      isClosed: false,
      child: { kill: vi.fn() },
    } as unknown as AgentCoreRuntimeClient;
    const item = {
      key: identity(cwd, sessionId),
      runtime,
      busy: true,
      restartPending: false,
      model: "lab",
      thinking: null,
      config: { model: "lab" },
      eventSequence: 0,
      lastProgressAt: Date.now(),
    } as unknown as Live;

    try {
      await recover(context, item);
      await vi.waitFor(
        () => {
          expect(recoveryFailures(received)).toHaveLength(3);
        },
        { timeout: 10000 },
      );

      const failures = recoveryFailures(received);
      expect(failures[0]).toMatchObject({ recoverable: true, terminal: false });
      expect(failures[1]).toMatchObject({ recoverable: true, terminal: false });
      expect(failures[2]).toMatchObject({ terminal: true });
      expect(failures[2]).not.toHaveProperty("recoverable");
      expect(context.recoveryAttempts.get(identity(cwd, sessionId))).toBe(3);
    } finally {
      unsubscribe();
      for (const timer of context.recoveryTimers.values()) clearTimeout(timer);
    }
  }, 20000);
});
