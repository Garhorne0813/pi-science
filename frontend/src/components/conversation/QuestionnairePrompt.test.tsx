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
