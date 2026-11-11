import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { MAX_QUESTIONS } from "../questionnaire-limits.js";
import registerAskUserQuestion from "./pi-science-ask-user-question-web.js";

type BridgeQuestion = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
};

/** `count` distinct questions with `optionCount` distinct options each. */
function bridgeQuestions(count: number, optionCount = 2): BridgeQuestion[] {
  return Array.from({ length: count }, (_, questionIndex) => ({
    question: `Question ${questionIndex + 1}?`,
    header: `H${questionIndex + 1}`,
    options: Array.from({ length: optionCount }, (_, optionIndex) => ({
      label: `Option ${questionIndex + 1}.${optionIndex + 1}`,
      description: `Description ${questionIndex + 1}.${optionIndex + 1}`,
    })),
  }));
}

/** Register the tool against a stub Pi API and return its declaration. */
function registeredTool(): any {
  let registered: any;
  registerAskUserQuestion({
    registerTool: (tool: any) => {
      registered = tool;
    },
  });
  return registered;
}

const browserContext = (input: any) => ({ hasUI: true, mode: "web", ui: { input } });

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
          {
            questionIndex: 1,
            kind: "multi",
            selected: ["Figures", "Tables"],
            notes: "Include both.",
          },
        ],
      });
    });

    registerAskUserQuestion({
      registerTool: (registered: any) => {
        tool = registered;
      },
    });
    const result = await tool.execute(
      "call-1",
      {
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
      },
      undefined,
      undefined,
      { hasUI: true, mode: "web", ui: { input } },
    );

    expect(input).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      cancelled: false,
      answers: [
        expect.objectContaining({
          kind: "option",
          answer: "Fast",
          preview: "**fast**",
          notes: "Keep latency low.",
        }),
        expect.objectContaining({
          kind: "multi",
          selected: ["Figures", "Tables"],
          notes: "Include both.",
        }),
      ],
    });
    expect(result.content[0].text).toContain("selected preview: **fast**");
    expect(result.content[0].text).toContain("user notes: Include both.");
  });

  it.each([1, 4, 5, MAX_QUESTIONS])(
    "accepts %i questions in one browser request and keeps them in order",
    async (count) => {
      const questions = bridgeQuestions(count);
      const answers = questions.map((question, questionIndex) => ({
        questionIndex,
        kind: "option",
        answer: question.options[0]!.label,
      }));
      const input = vi.fn(async () => JSON.stringify({ cancelled: false, answers }));

      const result = await registeredTool().execute(
        "call-long",
        { questions },
        undefined,
        undefined,
        browserContext(input),
      );

      expect(input).toHaveBeenCalledTimes(1);
      expect(result.details.cancelled).toBe(false);
      expect(result.details.answers).toHaveLength(count);
      expect(result.details.answers.map((answer: any) => answer.questionIndex)).toEqual(
        questions.map((_question, index) => index),
      );
      expect(result.details.answers.map((answer: any) => answer.question)).toEqual(
        questions.map((question) => question.question),
      );
      expect(result.details.answers.map((answer: any) => answer.answer)).toEqual(
        questions.map((question) => question.options[0]!.label),
      );
      let cursor = -1;
      for (const question of questions) {
        const at = result.content[0].text.indexOf(`"${question.question}"`);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
    },
  );

  it("rejects one question past the shared limit without touching the browser", async () => {
    const input = vi.fn();

    const result = await registeredTool().execute(
      "call-too-many",
      { questions: bridgeQuestions(MAX_QUESTIONS + 1) },
      undefined,
      undefined,
      browserContext(input),
    );

    expect(input).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ cancelled: true, error: "too_many_questions" });
    expect(result.content[0].text).toBe(`Error: at most ${MAX_QUESTIONS} questions are allowed`);
  });

  it("declares the shared limit in its schema and prompt text", () => {
    const tool = registeredTool();
    const schema = tool.parameters.properties.questions;

    expect(schema.minItems).toBe(1);
    expect(schema.maxItems).toBe(MAX_QUESTIONS);
    expect(tool.promptSnippet).toBe(
      `Ask the user up to ${MAX_QUESTIONS} structured questions when requirements are ambiguous`,
    );
    // Pi validates tool arguments with TypeBox before execute(), so the schema
    // is the gate a 21st question trips.
    expect(Value.Check(tool.parameters, { questions: bridgeQuestions(MAX_QUESTIONS) })).toBe(true);
    expect(Value.Check(tool.parameters, { questions: bridgeQuestions(MAX_QUESTIONS + 1) })).toBe(
      false,
    );
  });

  it("keeps the option range at two to four through the schema and the runtime guard", async () => {
    const tool = registeredTool();
    const payload = (optionCount: number) => ({ questions: bridgeQuestions(1, optionCount) });

    expect(Value.Check(tool.parameters, payload(2))).toBe(true);
    expect(Value.Check(tool.parameters, payload(4))).toBe(true);
    expect(Value.Check(tool.parameters, payload(5))).toBe(false);
    expect(tool.parameters.properties.questions.items.properties.options).toMatchObject({
      minItems: 2,
      maxItems: 4,
    });

    const input = vi.fn(async () =>
      JSON.stringify({
        cancelled: false,
        answers: [{ questionIndex: 0, kind: "option", answer: "Option 1.1" }],
      }),
    );
    const accepted = await tool.execute(
      "call-four-options",
      payload(4),
      undefined,
      undefined,
      browserContext(input),
    );
    expect(accepted.details.cancelled).toBe(false);

    const rejected = await tool.execute(
      "call-one-option",
      payload(1),
      undefined,
      undefined,
      browserContext(vi.fn()),
    );
    expect(rejected.details).toMatchObject({ cancelled: true, error: "empty_options" });
  });
});
