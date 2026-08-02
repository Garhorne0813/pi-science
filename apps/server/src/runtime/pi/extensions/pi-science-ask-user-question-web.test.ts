import { describe, expect, it, vi } from "vitest";
import registerAskUserQuestion from "./pi-science-ask-user-question-web.js";

describe("Pi-Science ask_user_question browser bridge", () => {
  it("sends one structured browser request and preserves previews, selections, and notes", async () => {
    let tool: any;
    const input = vi.fn(async (title: string, placeholder: string) => {
      expect(title).toBe("pi-science-questionnaire-v1:call-1");
      expect(placeholder).toBe("pi-science-questionnaire-response");
      return JSON.stringify({
        cancelled: false,
        answers: [
          { questionIndex: 0, kind: "option", answer: "Fast", notes: "Keep latency low." },
          { questionIndex: 1, kind: "multi", selected: ["Figures", "Tables"], notes: "Include both." },
        ],
      });
    });

    registerAskUserQuestion({ registerTool: (registered: any) => { tool = registered; } });
    const result = await tool.execute("call-1", {
      questions: [
        {
          question: "Which mode?",
          header: "Mode",
          options: [
            { label: "Fast", description: "Low latency", preview: "**fast**" },
            { label: "Safe", description: "Conservative" },
          ],
        },
        {
          question: "Which outputs?",
          header: "Outputs",
          multiSelect: true,
          options: [
            { label: "Figures", description: "Plots" },
            { label: "Tables", description: "Summaries" },
          ],
        },
      ],
    }, undefined, undefined, { hasUI: true, mode: "web", ui: { input } });

    expect(input).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      cancelled: false,
      answers: [
        expect.objectContaining({ kind: "option", answer: "Fast", preview: "**fast**", notes: "Keep latency low." }),
        expect.objectContaining({ kind: "multi", selected: ["Figures", "Tables"], notes: "Include both." }),
      ],
    });
    expect(result.content[0].text).toContain("selected preview: **fast**");
    expect(result.content[0].text).toContain("user notes: Include both.");
  });
});
