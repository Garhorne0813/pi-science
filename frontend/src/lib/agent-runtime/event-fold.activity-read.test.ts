import { expect, it } from "vitest";
import { emptyThread, foldEvent } from "./event-fold";
import { projectToolActivity } from "../conversation/projection";
import { activityRendererRegistry } from "../../components/conversation/activity-renderers/registry";
import type { PiScienceEvent } from "../client/types";
import type { ToolCallBlock } from "../../types/thread";
import { installRuntimeTestEnvironment } from "./test-helpers";

installRuntimeTestEnvironment();
const envelope = (overrides: Record<string, unknown>): PiScienceEvent => ({ schemaVersion: 3, workspaceId: "/workspace", sessionId: "session", streamEpoch: "epoch", eventId: "epoch:1", seq: 1, turnId: "turn", runId: "run", occurredAt: "2026-09-08T00:00:00.000Z", type: "tool.started", payload: {}, ...overrides });
it.each([true, false])("folds and renders read range with server presentation: %s", (withTitle) => {
  const event = envelope({ callId: "call", itemId: "call", tool: "read", status: "running", input: { path: "a.ts", offset: 120, limit: 40 }, ...(withTitle ? { title: "Reading a.ts:120-159", presentation: { version: 1, kind: "read", title: "Reading a.ts:120-159", importance: "micro", domain: "code" } } : {}) });
  const block = foldEvent(emptyThread(), event).blocks.find((item): item is ToolCallBlock => item.kind === "tool");
  expect(block).toBeDefined();
  const source = block!;
  const activity = projectToolActivity(source);
  const t = (key: string, values?: Record<string, unknown>) => key === "conversation.activity.read" ? `Reading ${values?.target}` : key;
  expect(activityRendererRegistry.resolve("tool").compact({ activity, source, live: false, t }).title).toBe("Reading a.ts:120-159");
});
