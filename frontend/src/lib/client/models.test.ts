import { describe, expect, it } from "vitest";

import { clampThinkingLevel, conversationModelOptions } from "../pi-science-client";


describe("conversation model menu", () => {
  it("clamps Think to the nearest level supported by the selected model", () => {
    expect(clampThinkingLevel("max", ["off", "minimal", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(clampThinkingLevel("high", ["minimal", "low", "medium", "high", "xhigh"])).toBe("high");
    expect(clampThinkingLevel("high", ["off"])).toBe("off");
    expect(clampThinkingLevel("unknown", ["minimal", "low"])).toBe("minimal");
  });

  it("keeps custom-provider models selectable in the conversation model menu", () => {
    const builtin = { id: "openai/gpt-5", provider: "openai", model: "gpt-5", label: "OpenAI · GPT-5" };
    const custom = { id: "custom-local/qwen3", provider: "custom-local", model: "qwen3", label: "Local · qwen3", custom: true };
    expect(conversationModelOptions([builtin, custom, custom])).toEqual([builtin, custom]);
  });
});
