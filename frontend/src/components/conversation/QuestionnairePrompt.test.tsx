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
  it("uses an accordion, auto-advances single choice, keeps multi-select open, and submits the structured payload", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);

    expect(screen.getByText("Which execution mode should we use?")).toBeInTheDocument();
    expect(screen.getByText("Which outputs are useful?")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "2");

    fireEvent.click(screen.getByRole("button", { name: "Notes for this question" }));
    fireEvent.change(screen.getByLabelText("Notes for this question"), { target: { value: "Keep latency low." } });
    fireEvent.click(screen.getByRole("button", { name: /Fast.*Prioritize turnaround time/ }));

    const outputsHeader = screen.getByRole("button", { name: /Outputs.*Which outputs are useful/ });
    expect(outputsHeader).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Figures.*Publication-ready plots/ }));
    expect(screen.getByText("figure preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Figures.*Publication-ready plots/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tables.*Machine-readable summaries/ }));

    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response = JSON.parse(onRespond.mock.calls[0]![0].value);
    expect(response.cancelled).toBe(false);
    expect(response.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ questionIndex: 0, kind: "option", answer: "Fast", notes: "Keep latency low.", preview: "**Fast mode**" }),
      expect.objectContaining({ questionIndex: 1, kind: "multi", selected: ["Figures", "Tables"] }),
    ]));
  });

  it("auto-advances after a first custom answer or an empty multi-select answer", () => {
    const onRespond = vi.fn();
    const customQuestionnaire: PendingQuestionnaire = {
      ...questionnaire,
      toolCallId: "call-2",
      questions: [
        {
          question: "Describe the experiment.",
          header: "Experiment",
          multiSelect: false,
          options: [{ label: "Baseline", description: "Use the existing setup." }],
        },
        questionnaire.questions[1]!,
        {
          question: "Should the follow-up be automated?",
          header: "Follow-up",
          multiSelect: false,
          options: [{ label: "Yes", description: "Run it automatically." }],
        },
      ],
    };
    render(<QuestionnairePrompt questionnaire={customQuestionnaire} interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByPlaceholderText("Write a custom answer…"), { target: { value: "A bespoke experiment" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    expect(screen.getByRole("button", { name: /Outputs.*Which outputs are useful/ })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Continue without selecting" }));
    expect(screen.getByRole("button", { name: /Follow-up.*Should the follow-up be automated/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("supports a custom answer and cancellation from the persistent footer", () => {
    const onRespond = vi.fn();
    const singleQuestion = { ...questionnaire, toolCallId: "call-3", questions: [questionnaire.questions[0]!] };
    render(<QuestionnairePrompt questionnaire={singleQuestion} interaction={interaction} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByPlaceholderText("Write a custom answer…"), { target: { value: "A bespoke mode" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers[0]).toMatchObject({ kind: "custom", answer: "A bespoke mode" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRespond).toHaveBeenLastCalledWith({ cancelled: true });
  });
});
