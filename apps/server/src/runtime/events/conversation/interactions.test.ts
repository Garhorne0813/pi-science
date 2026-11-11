import { describe, expect, it } from "vitest";
import { MAX_QUESTIONS } from "../../shared/questionnaire-limits.js";
import { questionnairePayload } from "./interactions.js";

type ProjectedOption = { label: string; description: string; preview?: string };
type ProjectedQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ProjectedOption[];
};

/** `count` distinct questions with `optionCount` distinct options each. */
function rawQuestions(count: number, optionCount = 2): unknown[] {
  return Array.from({ length: count }, (_, questionIndex) => ({
    question: `Question ${questionIndex + 1}?`,
    header: `H${questionIndex + 1}`,
    options: Array.from({ length: optionCount }, (_, optionIndex) => ({
      label: `Option ${questionIndex + 1}.${optionIndex + 1}`,
      description: `Description ${questionIndex + 1}.${optionIndex + 1}`,
    })),
  }));
}

function projected(args: unknown): ProjectedQuestion[] {
  const payload = questionnairePayload("session-1", "call-1", args);
  expect(payload).not.toBeNull();
  expect(payload!.type).toBe("questionnaire.asked");
  expect(payload!.sessionId).toBe("session-1");
  expect(payload!.toolCallId).toBe("call-1");
  return payload!.questions as ProjectedQuestion[];
}

describe("questionnairePayload", () => {
  it.each([1, 4, 5, MAX_QUESTIONS])(
    "forwards %i questions in order with the same text and option counts",
    (count) => {
      const questions = rawQuestions(count, 3);

      const result = projected({ questions });

      expect(result).toHaveLength(count);
      expect(result.map((question) => question.question)).toEqual(
        questions.map((_question, index) => `Question ${index + 1}?`),
      );
      expect(result.map((question) => question.header)).toEqual(
        questions.map((_question, index) => `H${index + 1}`),
      );
      expect(result.map((question) => question.options.length)).toEqual(
        Array.from({ length: count }, () => 3),
      );
      expect(result[0]!.options[0]).toEqual({
        label: "Option 1.1",
        description: "Description 1.1",
      });
      expect(result.at(-1)!.options.at(-1)).toEqual({
        label: `Option ${count}.3`,
        description: `Description ${count}.3`,
      });
    },
  );

  it("keeps its defensive cap at the shared limit", () => {
    const result = projected({ questions: rawQuestions(MAX_QUESTIONS + 1) });

    expect(result).toHaveLength(MAX_QUESTIONS);
    expect(result[0]!.question).toBe("Question 1?");
    expect(result.at(-1)!.question).toBe(`Question ${MAX_QUESTIONS}?`);
  });

  it("still caps a question at four options and keeps previews", () => {
    const result = projected({
      questions: [
        {
          question: "Which mode?",
          header: "Mode",
          options: [
            ...Array.from({ length: 4 }, (_, index) => ({
              label: `Option ${index + 1}`,
              description: `Description ${index + 1}`,
            })),
            { label: "Option 5", description: "Description 5", preview: "**fifth**" },
          ],
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.options.map((option) => option.label)).toEqual([
      "Option 1",
      "Option 2",
      "Option 3",
      "Option 4",
    ]);
    expect(result[0]!.options.every((option) => option.preview === undefined)).toBe(true);
    expect(
      projected({
        questions: [
          {
            question: "Which mode?",
            header: "Mode",
            options: [
              { label: "Fast", description: "Low latency", preview: "**fast**" },
              { label: "Safe", description: "Conservative" },
            ],
          },
        ],
      })[0]!.options[0]!.preview,
    ).toBe("**fast**");
  });

  it.each([null, undefined, "questions", 42, [], [{ question: "Question 1?" }]])(
    "returns null for args without a question list (%j)",
    (args) => {
      expect(questionnairePayload("session-1", "call-1", args)).toBeNull();
    },
  );

  it("returns null for an empty question list and for a non-array questions field", () => {
    expect(questionnairePayload("session-1", "call-1", { questions: [] })).toBeNull();
    expect(
      questionnairePayload("session-1", "call-1", { questions: { question: "Question 1?" } }),
    ).toBeNull();
  });

  it("skips malformed questions and malformed options without dropping the rest", () => {
    const result = projected({
      questions: [
        "not a question",
        null,
        {
          question: "Kept?",
          header: "Keep",
          options: [
            { label: "Fast", description: "Low latency" },
            null,
            "nope",
            { label: "Safe", description: "Conservative" },
          ],
        },
        { question: "Kept too?", header: "Keep too", options: [] },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.map((question) => question.question)).toEqual(["Kept?", "Kept too?"]);
    expect(result[0]!.options.map((option) => option.label)).toEqual(["Fast", "Safe"]);
    expect(result[1]!.options).toEqual([]);
  });

  it("normalizes missing fields instead of throwing", () => {
    const result = projected({ questions: [{ question: "Only a question?" }] });

    expect(result).toEqual([
      { question: "Only a question?", header: "", multiSelect: false, options: [] },
    ]);
  });
});
