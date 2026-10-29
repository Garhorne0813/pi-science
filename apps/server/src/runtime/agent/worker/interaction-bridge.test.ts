import { describe, expect, it, vi } from "vitest";
import { InteractionBridge } from "./interaction-bridge.js";
import { questionnaireHarnessTool } from "./questionnaire-tool.js";

describe("agent-core questionnaire bridge", () => {
  it("round trips a browser answer through the existing interaction notification", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = new InteractionBridge((event) => events.push(event));
    const tool = questionnaireHarnessTool(bridge);
    const result = tool.execute("call-1", {
      questions: [{ question: "Which analysis?", header: "Method", options: [
        { label: "A", description: "First" }, { label: "B", description: "Second" },
      ] }],
    }, () => undefined, {} as never, {} as never, { abortSignal: undefined } as never);
    expect(events).toMatchObject([{ type: "interaction.requested", method: "input",
      title: "pi-science-questionnaire-v1:call-1", id: expect.any(String) }]);
    expect(bridge.notify("extension_ui_response", { id: events[0]!.id,
      value: JSON.stringify({ cancelled: false, answers: [{ questionIndex: 0, kind: "option", answer: "B" }] }) })).toMatchObject({ success: true });
    expect(await result).toMatchObject({ details: { cancelled: false,
      answers: [expect.objectContaining({ answer: "B" })] } });
    bridge.close();
  });

  it("resolves a cancelled browser request", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = new InteractionBridge((event) => events.push(event));
    const answer = bridge.request("question", "");
    expect(bridge.notify("extension_ui_response", { id: events[0]!.id, cancelled: true })).toMatchObject({ success: true });
    expect(await answer).toBeNull();
  });

  it("shows concurrent permission requests one at a time without reusing Allow once", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = new InteractionBridge(event => events.push(event));
    const first = bridge.confirmPermission("command A", "A");
    const second = bridge.confirmPermission("command B", "B");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    bridge.notify("extension_ui_response", { id: events[0]!.id, confirmed: true });
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ title: "command B" });
    bridge.notify("extension_ui_response", { id: events[1]!.id, confirmed: false });
    expect(await second).toBe(false);
    bridge.close();
  });

  it("holds a submitted decision until grant persistence finishes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = new InteractionBridge(event => events.push(event));
    const settled = vi.fn();
    const first = bridge.confirmPermission("MCP", "params").then(value => { settled(value); return value; });
    const second = bridge.confirmPermission("next", "params");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const id = events[0]!.id;
    expect(bridge.notify("extension_ui_response", { id, confirmed: true, deferResolution: true })).toMatchObject({ success: true });
    expect(bridge.notify("extension_ui_response", { id, confirmed: true })).toMatchObject({ success: false });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled(); expect(events).toHaveLength(1);
    expect(bridge.notify("extension_ui_response", { id, complete: true })).toMatchObject({ success: true });
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    bridge.notify("extension_ui_response", { id: events[1]!.id, confirmed: false });
    await second; bridge.close();
  });

  it("withdraws queued permissions when the worker closes", async () => {
    const events: Array<Record<string, unknown>> = [];
    const bridge = new InteractionBridge(event => events.push(event));
    const first = bridge.confirmPermission("first", "");
    const second = bridge.confirmPermission("second", "");
    const outcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    bridge.close();
    expect((await outcomes).map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(events).toHaveLength(1); expect(bridge.hasPending).toBe(false);
  });

  it("withdraws a cancelled visible card before presenting its successor", async () => {
    const events: Array<Record<string, unknown>> = [], abort = new AbortController();
    const bridge = new InteractionBridge(event => events.push(event));
    const first = bridge.confirmPermission("first", "", abort.signal);
    const second = bridge.confirmPermission("second", "");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    abort.abort(); expect(await first).toBe(false);
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(events[1]).toEqual({ type: "interaction.resolved", id: events[0]!.id });
    expect(events[2]).toMatchObject({ type: "interaction.requested", title: "second" });
    bridge.notify("extension_ui_response", { id: events[2]!.id, confirmed: false });
    await second; bridge.close();
  });

  it("keeps an aborted submitted call inside its persistence scope until completion", async () => {
    const events: Array<Record<string, unknown>> = [], abort = new AbortController();
    const bridge = new InteractionBridge(event => events.push(event));
    const settled = vi.fn();
    const call = bridge.withPermission("cancel-during-save", () => bridge.confirmPermission("MCP", "", abort.signal), abort.signal)
      .then(value => { settled(value); return value; });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const id = events[0]!.id;
    bridge.notify("extension_ui_response", { id, confirmed: true, deferResolution: true });
    abort.abort(); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    bridge.notify("extension_ui_response", { id, complete: true });
    expect(await call).toBe(false); bridge.close();
  });
});
