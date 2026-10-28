import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentCoreSessionService } from "./agent-core-session-service.js";
import { ConversationEventHub } from "../events/conversation-event-hub.js";

it("uses hooks configured after attachment and drains their work through the composed hub", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-session-composition-"));
  const hub = new ConversationEventHub({ append: async () => undefined, readAfter: async () => [] });
  const service = new AgentCoreSessionService(hub, {} as never);
  const original = vi.fn();
  const replacement = vi.fn();
  const runtime = Object.assign(new EventEmitter(), {
    cwd, sessionId: "composition", isClosed: false,
    sendCommand: async (command: string) => command === "get_state"
      ? { success: true, data: { busy: false } } : { success: true },
  });
  try {
    service.configureProductLifecycle({ observe: original });
    const attaching = service as unknown as {
      attach(key: string, runtime: unknown, model: string, thinking: string, config: unknown): Promise<unknown>;
    };
    await attaching.attach("composition", runtime, "provider/model", "off", {});
    service.configureProductLifecycle({ observe: replacement });
    runtime.emit("event", { type: "message.started", message: { role: "assistant", id: "message", content: [] } });
    await hub.flush(cwd);
    expect(original).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledOnce();
    expect(replacement.mock.calls[0]?.slice(0, 2)).toEqual([cwd, "composition"]);
  } finally {
    await service.shutdownAll();
    await rm(cwd, { recursive: true, force: true });
  }
});
