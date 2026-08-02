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
  it("supports tabbed questions, previews, notes, multi-select, and structured submit", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);

    expect(screen.getByText("Which execution mode should we use?")).toBeInTheDocument();
    expect(screen.getByText("Prioritize turnaround time.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Fast.*Prioritize turnaround time/ }));
    fireEvent.change(screen.getByLabelText("Notes for this question"), { target: { value: "Keep latency low." } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    expect(screen.getByText("Which outputs are useful?")).toBeInTheDocument();
    expect(screen.getByText("figure preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Figures.*Publication-ready plots/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tables.*Machine-readable summaries/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response = JSON.parse(onRespond.mock.calls[0]![0].value);
    expect(response.cancelled).toBe(false);
    expect(response.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionIndex: 0, kind: "option", answer: "Fast", notes: "Keep latency low.", preview: "**Fast mode**" }),
      expect.objectContaining({ questionIndex: 1, kind: "multi", selected: ["Figures", "Tables"] }),
    ]));
  });

  it("supports a custom answer and cancellation", () => {
    const onRespond = vi.fn();
    const singleQuestion = { ...questionnaire, toolCallId: "call-2", questions: [questionnaire.questions[0]!] };
    render(<QuestionnairePrompt questionnaire={singleQuestion} interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByPlaceholderText("Write a custom answer…"), { target: { value: "A bespoke mode" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers[0]).toMatchObject({ kind: "custom", answer: "A bespoke mode" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRespond).toHaveBeenLastCalledWith({ cancelled: true });
  });
});
