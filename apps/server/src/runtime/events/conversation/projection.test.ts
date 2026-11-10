import { describe, expect, it } from "vitest";
import { ConversationProjection } from "./projection.js";
import { ConversationStreams } from "./streams.js";

describe("tool update progress projection", () => {
  it("normalizes progress without changing output or approval", () => {
    const projection = new ConversationProjection(new ConversationStreams({}));
    const update = (partialResult: unknown) =>
      projection.normalize("/workspace", "session", {
        type: "tool.updated",
        toolCallId: "call",
        toolName: "tool",
        partialResult,
      } as never)[0]!;
    const progress = {
      version: 1,
      scopeId: "work",
      scopeLabel: "Work",
      current: 1,
      total: 2,
      totalKind: "fixed",
      determinate: false,
    };
    const normalized = { ...progress, determinate: true };
    const plain = update({ content: [{ type: "text", text: "hello" }] });
    expect(plain.partialOutput).toBe("hello");
    expect(plain).not.toHaveProperty("progress");
    expect(update({ content: [{ type: "text", text: "hello" }], details: { progress } })).toEqual({
      ...plain,
      progress: normalized,
    });
    const empty = update({ content: [], details: { progress } });
    expect(empty.progress).toEqual(normalized);
    expect(empty).not.toHaveProperty("partialOutput");
    const waiting = update(
      JSON.stringify({ content: [], details: { approval: "waiting", progress } }),
    );
    expect(waiting.status).toBe("waiting-approval");
    expect(waiting.progress).toEqual(normalized);
    expect(waiting).not.toHaveProperty("partialOutput");
  });
});
