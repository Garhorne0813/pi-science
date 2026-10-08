import { describe, expect, it } from "vitest";
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
});
