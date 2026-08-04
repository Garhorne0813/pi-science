import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import { QuestionnairePrompt } from "./QuestionnairePrompt";
import type { PendingInteraction, PendingQuestionnaire } from "../../lib/agent-runtime";

const interaction: PendingInteraction = {
  requestId: "questionnaire-request",
  method: "input",
  title: "Questionnaire",
  questionnaire: true,
};

const questionnaire: PendingQuestionnaire = {
  toolCallId: "call-1",
  questions: [
    {
      question: "Which execution mode should we use?",
      header: "Mode",
      multiSelect: false,
      options: [
        { label: "Fast", description: "Prioritize turnaround time.", preview: "**Fast mode**" },
        { label: "Safe", description: "Prioritize conservative changes." },
      ],
    },
    {
      question: "Which outputs are useful?",
      header: "Outputs",
      multiSelect: true,
      options: [
        { label: "Figures", description: "Publication-ready plots.", preview: "**figure preview**" },
        { label: "Tables", description: "Machine-readable summaries." },
      ],
    },
  ],
};

const outOfOrderQuestionnaire: PendingQuestionnaire = {
  toolCallId: "call-out-of-order",
  questions: [
    questionnaire.questions[0]!,
    {
      question: "Which transport should we use?",
      header: "Transport",
      multiSelect: false,
      options: [
        { label: "Local", description: "Run beside the current session." },
        { label: "Remote", description: "Run on a remote worker." },
      ],
    },
    {
      question: "Which output format should we use?",
      header: "Format",
      multiSelect: false,
      options: [
        { label: "JSON", description: "Structured machine-readable output." },
        { label: "CSV", description: "Tabular output." },
      ],
    },
  ],
};

describe("QuestionnairePrompt", () => {
  it("answers through the accordion with auto-advance and submits a structured payload", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);

    expect(screen.getByText("Which execution mode should we use?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();

    // First answer to the single-select question auto-advances to the next
    // unanswered question (its options only render once it is open).
    fireEvent.click(screen.getByRole("button", { name: /Fast.*Prioritize turnaround time/ }));
    expect(screen.getByRole("button", { name: /Figures.*Publication-ready plots/ })).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");

    fireEvent.click(screen.getByRole("button", { name: /Figures.*Publication-ready plots/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tables.*Machine-readable summaries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response = JSON.parse(onRespond.mock.calls[0]![0].value);
    expect(response.cancelled).toBe(false);
    expect(response.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionIndex: 0, kind: "option", answer: "Fast", preview: "**Fast mode**" }),
      expect.objectContaining({ questionIndex: 1, kind: "multi", selected: ["Figures", "Tables"] }),
    ]));
  });

  it("supports a custom answer, collapsible notes, and cancellation", () => {
    const onRespond = vi.fn();
    const singleQuestion = { ...questionnaire, toolCallId: "call-2", questions: [questionnaire.questions[0]!] };
    render(<QuestionnairePrompt questionnaire={singleQuestion} interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByPlaceholderText("Write a custom answer…"), { target: { value: "A bespoke mode" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));

    fireEvent.click(screen.getByRole("button", { name: /Notes for this question/ }));
    fireEvent.change(screen.getByPlaceholderText("Add context or constraints (optional)…"), { target: { value: "Keep latency low." } });

    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers[0]).toMatchObject({
      kind: "custom",
      answer: "A bespoke mode",
      notes: "Keep latency low.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRespond).toHaveBeenLastCalledWith({ cancelled: true });
  });

  it("toggles the custom editor and clears its draft from the inner cancel", () => {
    const onRespond = vi.fn();
    const singleQuestion = { ...questionnaire, toolCallId: "call-custom-toggle", questions: [questionnaire.questions[0]!] };
    render(<QuestionnairePrompt questionnaire={singleQuestion} interaction={interaction} onRespond={onRespond} />);

    const customToggle = screen.getByRole("button", { name: /Type something/ });
    expect(customToggle).toHaveAttribute("aria-expanded", "false");
    expect(customToggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(customToggle);
    expect(customToggle).toHaveAttribute("aria-expanded", "true");
    expect(customToggle).toHaveAttribute("aria-pressed", "true");
    const customTextarea = screen.getByRole("textbox", { name: "Your answer" });
    fireEvent.change(customTextarea, { target: { value: "A draft to discard" } });

    // The same control closes and reopens the editor without losing its draft.
    fireEvent.click(customToggle);
    expect(customToggle).toHaveAttribute("aria-expanded", "false");
    expect(customToggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(customToggle);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("A draft to discard");

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    expect(customToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(customToggle);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("");
  });

  it("advances to the first incomplete question and only opens review when all are answered", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={outOfOrderQuestionnaire} interaction={interaction} onRespond={onRespond} />);

    // Answer Q2 first: auto-advance must return to Q1, not scan only forward.
    fireEvent.click(screen.getByRole("button", { name: /Which transport should we use\?/ }));
    fireEvent.click(screen.getByRole("button", { name: /Remote.*Run on a remote worker/ }));
    expect(screen.getByRole("button", { name: /Fast.*Prioritize turnaround time/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Fast.*Prioritize turnaround time/ }));
    expect(screen.getByRole("button", { name: /JSON.*Structured machine-readable output/ })).toBeInTheDocument();

    // Editing an already completed question must not auto-advance away from it.
    fireEvent.click(screen.getByRole("button", { name: /Which execution mode should we use\?/ }));
    fireEvent.click(screen.getByRole("button", { name: /Safe.*Prioritize conservative changes/ }));
    expect(screen.getByRole("button", { name: /Safe.*Prioritize conservative changes/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /JSON.*Structured machine-readable output/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Which output format should we use\?/ }));
    fireEvent.click(screen.getByRole("button", { name: /JSON.*Structured machine-readable output/ }));
    expect(screen.getByRole("button", { name: "Hide review" })).toBeInTheDocument();
  });

  it("names the progressbar and textareas and links accordion headers to panels", () => {
    const onRespond = vi.fn();
    const singleQuestion = { ...questionnaire, toolCallId: "call-a11y", questions: [questionnaire.questions[0]!] };
    render(<QuestionnairePrompt questionnaire={singleQuestion} interaction={interaction} onRespond={onRespond} />);

    expect(screen.getByRole("progressbar")).toHaveAccessibleName("0 of 1 answered");
    const header = screen.getByRole("button", { name: /Which execution mode should we use\?/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    const panelId = header.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Notes for this question/ }));
    expect(screen.getByRole("textbox", { name: "Notes for this question" })).toBeInTheDocument();
  });

  it("toggles the answer summary and jumps back to a question from it", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("button", { name: /Which execution mode should we use\?.*Unanswered/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide review" }));
    expect(screen.queryByText("Unanswered")).not.toBeInTheDocument();

    // Jumping back from the summary re-opens the question body.
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: /Which execution mode should we use\?.*Unanswered/ }));
    expect(screen.getByRole("button", { name: /Fast.*Prioritize turnaround time/ })).toBeInTheDocument();
    expect(screen.queryByText("Unanswered")).not.toBeInTheDocument();
  });
});
