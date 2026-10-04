/**
 * Browser bridge for @juicesharp/rpiv-ask-user-question.
 *
 * Pi's Web/RPC UI protocol only exposes select/input primitives. The upstream
 * package therefore falls back to one dialog per question and cannot transport
 * its tabbed preview/notes UI. This adapter is loaded before the upstream
 * package (Pi keeps the first tool registration) and uses one namespaced input
 * request as a small JSON envelope. Pi-Science renders that envelope as the
 * full questionnaire in the browser and sends the structured result back.
 *
 * The upstream package remains in the runtime extension list: it is still the
 * canonical package for native Pi hosts and supplies the same public tool
 * contract. This file only owns the browser-compatible implementation.
 */

const TOOL_NAME = "ask_user_question";
const REQUEST_PREFIX = "pi-science-questionnaire-v1:";
const RESPONSE_PLACEHOLDER = "pi-science-questionnaire-response";
const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_LENGTH = 16;
const MAX_LABEL_LENGTH = 60;
const CUSTOM_LABEL = "Type something.";
const RESERVED_LABELS = new Set(["Other", CUSTOM_LABEL, "Next"]);

// A JSON Schema object is enough here. Pi loads extension TypeScript through
// jiti, while the runtime already validates the schema before execute(). Avoid
// importing the runtime's private TypeBox installation from this source file.
const QUESTION_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string" },
          header: { type: "string", maxLength: MAX_HEADER_LENGTH },
          multiSelect: { type: "boolean", default: false },
          options: {
            type: "array",
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "description"],
              properties: {
                label: { type: "string", maxLength: MAX_LABEL_LENGTH },
                description: { type: "string" },
                preview: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildToolResult(textValue: string, details: Record<string, unknown>) {
  return { content: [{ type: "text", text: textValue }], details };
}

function validateQuestionnaire(params: unknown): { ok: true; questions: Question[] } | { ok: false; message: string; error: string } {
  const questions = isRecord(params) && Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) return { ok: false, message: "Error: no questions were provided", error: "no_questions" };
  if (questions.length > MAX_QUESTIONS) return { ok: false, message: `Error: at most ${MAX_QUESTIONS} questions are allowed`, error: "too_many_questions" };

  const seenQuestions = new Set<string>();
  const normalized: Question[] = [];
  for (const rawQuestion of questions) {
    if (!isRecord(rawQuestion)) return { ok: false, message: "Error: invalid question", error: "invalid_question" };
    const question = text(rawQuestion.question);
    const header = text(rawQuestion.header);
    const rawOptions = Array.isArray(rawQuestion.options) ? rawQuestion.options : [];
    if (seenQuestions.has(question)) return { ok: false, message: `Error: duplicate question: ${question}`, error: "duplicate_question" };
    seenQuestions.add(question);
    if (rawOptions.length < MIN_OPTIONS) return { ok: false, message: "Error: every question needs at least two options", error: "empty_options" };

    const seenLabels = new Set<string>();
    const options: Option[] = [];
    for (const rawOption of rawOptions) {
      if (!isRecord(rawOption)) return { ok: false, message: "Error: invalid option", error: "invalid_option" };
      const label = text(rawOption.label);
      const description = text(rawOption.description);
      if (RESERVED_LABELS.has(label)) return { ok: false, message: `Error: reserved option label: ${label}`, error: "reserved_label" };
      if (seenLabels.has(label)) return { ok: false, message: `Error: duplicate option label: ${label}`, error: "duplicate_option_label" };
      seenLabels.add(label);
      options.push({
        label,
        description,
        ...(typeof rawOption.preview === "string" && rawOption.preview.length > 0 ? { preview: rawOption.preview } : {}),
      });
    }
    normalized.push({
      question,
      header,
      multiSelect: rawQuestion.multiSelect === true,
      options,
    });
  }
  return { ok: true, questions: normalized };
}

type Option = { label: string; description: string; preview?: string };
type Question = { question: string; header: string; multiSelect: boolean; options: Option[] };
type Answer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
};

function formatAnswer(answer: Answer): string {
  if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : "(no input)";
  if (answer.kind === "custom") return answer.answer ? answer.answer : "(no input)";
  return answer.answer ?? "(no input)";
}

function buildAnswerSegment(answer: Answer): string {
  const parts = [`"${answer.question}"="${formatAnswer(answer)}"`];
  if (answer.preview) parts.push(`selected preview: ${answer.preview}`);
  if (answer.notes) parts.push(`user notes: ${answer.notes}`);
  return `${parts.join(". ")}.`;
}

function buildQuestionnaireResponse(result: { answers: Answer[]; cancelled: boolean }, questions: Question[]) {
  if (result.cancelled) {
    return buildToolResult("User declined to answer questions", { answers: result.answers, cancelled: true });
  }
  const segments = questions
    .map((_question, index) => result.answers.find((answer) => answer.questionIndex === index))
    .filter((answer): answer is Answer => Boolean(answer))
    .map(buildAnswerSegment);
  if (segments.length === 0) {
    return buildToolResult("User declined to answer questions", { answers: result.answers, cancelled: true });
  }
  return buildToolResult(
    `User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`,
    { answers: result.answers, cancelled: false },
  );
}

function parseBrowserResult(raw: string, questions: Question[]): { answers: Answer[]; cancelled: boolean } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed)) return null;
  if (parsed.cancelled === true) return { answers: [], cancelled: true };
  if (!Array.isArray(parsed.answers)) return null;

  const answers: Answer[] = [];
  for (const rawAnswer of parsed.answers) {
    if (!isRecord(rawAnswer)) continue;
    const questionIndex = Number(rawAnswer.questionIndex);
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) continue;
    const question = questions[questionIndex];
    if (!question) continue;
    const kind = rawAnswer.kind;
    if (kind !== "option" && kind !== "custom" && kind !== "multi") continue;
    if (kind === "option") {
      const answer = text(rawAnswer.answer);
      const option = question.options.find((item) => item.label === answer);
      if (!option || question.multiSelect) continue;
      answers.push({ questionIndex, question: question.question, kind, answer, ...(option.preview ? { preview: option.preview } : {}), ...(text(rawAnswer.notes) ? { notes: text(rawAnswer.notes) } : {}) });
    } else if (kind === "multi") {
      if (!question.multiSelect) continue;
      const selected = Array.isArray(rawAnswer.selected)
        ? [...new Set(rawAnswer.selected.map(text).filter((label) => question.options.some((item) => item.label === label)))]
        : [];
      answers.push({ questionIndex, question: question.question, kind, answer: null, selected, ...(text(rawAnswer.notes) ? { notes: text(rawAnswer.notes) } : {}) });
    } else {
      if (question.multiSelect && rawAnswer.answer === null) continue;
      answers.push({ questionIndex, question: question.question, kind, answer: text(rawAnswer.answer), ...(text(rawAnswer.notes) ? { notes: text(rawAnswer.notes) } : {}) });
    }
  }
  const unique = [...new Map(answers.map((answer) => [answer.questionIndex, answer])).values()].sort((a, b) => a.questionIndex - b.questionIndex);
  return { answers: unique, cancelled: false };
}

async function runPrimitiveQuestionnaire(ctx: any, questions: Question[]): Promise<{ answers: Answer[]; cancelled: boolean }> {
  const answers: Answer[] = [];
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const question = questions[questionIndex];
    if (!question) continue;
    const lines = question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`);
    if (question.multiSelect) {
      const value = await ctx.ui.input(`${question.header ? `[${question.header}] ` : ""}${question.question}\n\n${lines.join("\n")}\n\nEnter numbers separated by commas, or type a custom answer.`, "1,3");
      if (value == null) return { answers, cancelled: true };
      const tokens = text(value).trim().split(/[,\s]+/).filter(Boolean);
      const indexes = tokens.map((token) => /^\d+\.?$/.test(token) ? Number.parseInt(token, 10) - 1 : -1);
      if (tokens.length > 0 && indexes.every((index) => index >= 0 && index < question.options.length)) {
        answers.push({ questionIndex, question: question.question, kind: "multi", answer: null, selected: [...new Set(indexes.map((index) => question.options[index]!.label))] });
      } else {
        answers.push({ questionIndex, question: question.question, kind: "custom", answer: text(value).trim() });
      }
      continue;
    }
    const chosen = await ctx.ui.select(`${question.header ? `[${question.header}] ` : ""}${question.question}`, [...lines, `${question.options.length + 1}. ${CUSTOM_LABEL}`]);
    if (chosen == null) return { answers, cancelled: true };
    const index = Number.parseInt(text(chosen), 10) - 1;
    if (index >= 0 && index < question.options.length) {
      const option = question.options[index]!;
      answers.push({ questionIndex, question: question.question, kind: "option", answer: option.label, ...(option.preview ? { preview: option.preview } : {}) });
    } else {
      const custom = await ctx.ui.input("Type your answer:", "");
      if (custom == null) return { answers, cancelled: true };
      answers.push({ questionIndex, question: question.question, kind: "custom", answer: custom });
    }
  }
  return { answers, cancelled: false };
}

export default function registerPiScienceAskUserQuestion(pi: any) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User Question",
    description: "Ask the user one or more structured questions during execution. Use this when requirements are ambiguous and you need concrete decisions. Each question must provide 2-4 options; users can select one, select several, type a custom answer, inspect markdown previews, and add notes.",
    promptSnippet: "Ask the user up to 4 structured questions when requirements are ambiguous",
    promptGuidelines: [
      "Use ask_user_question when you cannot proceed without a concrete user decision; group related questions into one invocation.",
      "Each question must have 2-4 options with concise labels and descriptions. Set multiSelect: true when multiple choices are valid.",
      "Do not author the reserved option labels Other, Type something., or Next; the UI provides the custom-answer affordance.",
    ],
    parameters: QUESTION_PARAMS_SCHEMA,
    async execute(_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      if (!ctx.hasUI) return buildToolResult("Error: UI not available (running in non-interactive mode)", { answers: [], cancelled: true, error: "no_ui" });
      const validation = validateQuestionnaire(params);
      if (!validation.ok) return buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error });

      // Pi-Science's web and RPC frontends recognize this stable title prefix,
      // then replace the primitive input with the full browser questionnaire.
      if (String(ctx.mode) !== "tui") {
        const requestTitle = `${REQUEST_PREFIX}${encodeURIComponent(_toolCallId)}`;
        const raw = await ctx.ui.input(requestTitle, RESPONSE_PLACEHOLDER);
        if (raw == null) return buildQuestionnaireResponse({ answers: [], cancelled: true }, validation.questions);
        const parsed = parseBrowserResult(raw, validation.questions);
        if (!parsed) return buildToolResult("Error: the questionnaire response was invalid", { answers: [], cancelled: true, error: "invalid_response" });
        return buildQuestionnaireResponse(parsed, validation.questions);
      }

      return buildQuestionnaireResponse(await runPrimitiveQuestionnaire(ctx, validation.questions), validation.questions);
    },
  });
}
