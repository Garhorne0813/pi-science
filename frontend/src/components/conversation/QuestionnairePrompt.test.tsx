import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const keyboardQuestionnaire: PendingQuestionnaire = { ...questionnaire, questions: [{
  question: "Choose a mode", header: "Mode", multiSelect: false,
  options: [{ label: "Fast", description: "" }, { label: "Safe", description: "" }, { label: "Balanced", description: "" }],
}] };

describe("compact QuestionnairePrompt", () => {
  it("shows one question and quiet options; selection never opens details or advances", () => {
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Which execution mode should we use?" })).toBeInTheDocument();
    expect(screen.queryByText("Which outputs are useful?")).not.toBeInTheDocument();
    expect(screen.queryByText("Prioritize turnaround time.")).not.toBeInTheDocument();
    expect(screen.queryByText("Fast mode")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Fast mode")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Safe" }));
    expect(screen.getByRole("heading")).toHaveTextContent("Which execution mode should we use?");
    expect(screen.getByLabelText("Question 1 of 2")).toHaveTextContent("1 / 2");
  });

  it("preserves single/multiple selections and submits the existing structured payload", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Which outputs are useful?" })).toHaveFocus();
    expect(screen.getByText("Select all that apply")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Figures" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tables" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("checkbox", { name: "Figures" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onRespond.mock.calls[0]![0].value)).toEqual({ cancelled: false, answers: [
      { questionIndex: 0, question: questionnaire.questions[0]!.question, kind: "option", answer: "Fast", preview: "**Fast mode**" },
      { questionIndex: 1, question: questionnaire.questions[1]!.question, kind: "multi", answer: null, selected: ["Figures", "Tables"] },
    ] });
  });

  it("opens description and Markdown only on demand without selecting an option", async () => {
    const user = userEvent.setup();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={vi.fn()} />);
    const info = screen.getByRole("button", { name: "Preview Fast" });
    await user.hover(info);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Prioritize turnaround time.");
    expect(screen.queryByText("Fast mode")).not.toBeInTheDocument();
    await user.click(info);
    expect(screen.getByRole("dialog", { name: "Preview Fast" })).toHaveTextContent("Fast mode");
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(info).toHaveFocus();
  });

  it("keeps notes and custom drafts while navigating, and saves before moving on", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Custom analysis" } });
    fireEvent.click(screen.getByRole("button", { name: "Notes for this question" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes for this question" }), { target: { value: " Keep latency low. " } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue without selecting" }));
    expect(screen.getByRole("heading")).toHaveTextContent("Which outputs are useful?");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("Custom analysis");
    expect(screen.getByRole("textbox", { name: "Notes for this question" })).toHaveValue(" Keep latency low. ");
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers).toEqual([
      expect.objectContaining({ kind: "custom", answer: "Custom analysis", notes: "Keep latency low." }),
      expect.objectContaining({ kind: "multi", selected: [] }),
    ]);
  });

  it("validates missing answers and jumps back to the incomplete question", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tables" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Please answer question 1");
    expect(screen.getByRole("heading", { name: "Which execution mode should we use?" })).toHaveFocus();
  });

  it("lets users review and return to a saved answer", () => {
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("heading", { name: "Review" })).toHaveFocus();
    expect(screen.getByRole("button", { name: /Which execution mode should we use\?.*Fast/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Which outputs are useful\?.*Unanswered/ }));
    expect(screen.getByRole("checkbox", { name: "Tables" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
  });

  it("moves and selects with arrow keys, and supports the submit shortcut", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={{ ...questionnaire, questions: [questionnaire.questions[0]!] }} interaction={interaction} onRespond={onRespond} />);
    screen.getByRole("radio", { name: "Fast" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Safe" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Safe" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: "Safe" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  it.each(["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"])("cycles and selects only radios with %s", async (key) => {
    const user = userEvent.setup();
    render(<QuestionnairePrompt questionnaire={keyboardQuestionnaire} interaction={interaction} onRespond={vi.fn()} />);
    const labels = key === "ArrowDown" || key === "ArrowRight" ? ["Safe", "Balanced", "Fast"] : ["Balanced", "Safe", "Fast"];
    screen.getByRole("radio", { name: "Fast" }).focus();
    for (const label of labels) {
      await user.keyboard(`{${key}}`);
      const selected = screen.getByRole("radio", { name: label });
      expect(selected).toHaveFocus();
      expect(selected).toBeChecked();
      expect(selected).toHaveAttribute("tabindex", "0");
      for (const radio of screen.getAllByRole("radio").filter((item) => item !== selected)) {
        expect(radio).not.toBeChecked();
        expect(radio).toHaveAttribute("tabindex", "-1");
      }
    }
    expect(screen.getByRole("button", { name: /Type something/ })).not.toHaveFocus();
    expect(screen.getByRole("heading")).toHaveTextContent("Choose a mode");
  });

  it.each([null, "Balanced"])("uses a single radio Tab entry and exit (selected: %s)", async (selection) => {
    const user = userEvent.setup();
    render(<><button type="button">Before group</button><QuestionnairePrompt questionnaire={keyboardQuestionnaire} interaction={interaction} onRespond={vi.fn()} /></>);
    if (selection) await user.click(screen.getByRole("radio", { name: selection }));
    const entry = screen.getByRole("radio", { name: selection ?? "Fast" });
    const before = screen.getByRole("button", { name: "Before group" });
    const custom = screen.getByRole("button", { name: /Type something/ });
    expect(within(screen.getByRole("radiogroup")).queryByRole("button", { name: /Type something/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio").filter((item) => item.tabIndex === 0)).toEqual([entry]);
    before.focus();
    await user.tab();
    expect(entry).toHaveFocus();
    await user.tab();
    expect(custom).toHaveFocus();
    await user.tab({ shift: true });
    expect(entry).toHaveFocus();
    await user.tab({ shift: true });
    expect(before).toHaveFocus();
    expect(entry).toHaveAttribute("aria-checked", selection ? "true" : "false");
  });

  it.each([null, "Safe", "Balanced"])("tabs through radios before all details with real descriptions (selected: %s)", async (selection) => {
    const user = userEvent.setup();
    const withDetails: PendingQuestionnaire = { ...keyboardQuestionnaire, questions: [{
      ...keyboardQuestionnaire.questions[0]!, options: keyboardQuestionnaire.questions[0]!.options.map((option) => ({ ...option, description: `Description for ${option.label}`, preview: `**${option.label} details**` })),
    }] };
    render(<><button type="button">Before group</button><QuestionnairePrompt questionnaire={withDetails} interaction={interaction} onRespond={vi.fn()} /></>);
    if (selection) await user.click(screen.getByRole("radio", { name: selection }));
    const entry = screen.getByRole("radio", { name: selection ?? "Fast" });
    const before = screen.getByRole("button", { name: "Before group" });
    const custom = screen.getByRole("button", { name: /Type something/ });
    expect(within(screen.getByRole("radiogroup")).queryAllByRole("button")).toHaveLength(0);
    before.focus();
    await user.tab();
    expect(entry).toHaveFocus();
    for (const label of ["Fast", "Safe", "Balanced"]) {
      await user.tab();
      const info = screen.getByRole("button", { name: `Preview ${label}` });
      expect(info).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: `Preview ${label}` })).toHaveTextContent(`${label} details`);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(info).toHaveFocus());
      expect(entry).toHaveAttribute("aria-checked", selection ? "true" : "false");
    }
    await user.tab();
    expect(custom).toHaveFocus();
    for (const label of ["Balanced", "Safe", "Fast"]) {
      await user.tab({ shift: true });
      expect(screen.getByRole("button", { name: `Preview ${label}` })).toHaveFocus();
    }
    await user.tab({ shift: true });
    expect(entry).toHaveFocus();
    await user.tab({ shift: true });
    expect(before).toHaveFocus();
  });

  it("keeps custom entry independent and resets the radio entry after a custom answer", async () => {
    const user = userEvent.setup();
    render(<QuestionnairePrompt questionnaire={keyboardQuestionnaire} interaction={interaction} onRespond={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Balanced" }));
    const custom = screen.getByRole("button", { name: /Type something/ });
    custom.focus();
    await user.keyboard("{ArrowLeft}{ArrowDown}");
    expect(custom).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Balanced" })).toBeChecked();
    await user.keyboard(" ");
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "My own mode");
    await user.click(screen.getByRole("button", { name: "Save answer" }));
    expect(screen.getAllByRole("radio").every((item) => item.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getAllByRole("radio").filter((item) => item.tabIndex === 0)).toEqual([screen.getByRole("radio", { name: "Fast" })]);
  });

  it("selects an unchecked focused radio with Space", async () => {
    const user = userEvent.setup();
    render(<QuestionnairePrompt questionnaire={keyboardQuestionnaire} interaction={interaction} onRespond={vi.fn()} />);
    const first = screen.getByRole("radio", { name: "Fast" });
    first.focus();
    await user.keyboard(" ");
    expect(first).toBeChecked();
    expect(first).toHaveFocus();
  });

  it("retains independent checkbox Tab stops and focus-only arrow navigation", async () => {
    const user = userEvent.setup();
    render(<QuestionnairePrompt questionnaire={{ ...keyboardQuestionnaire, questions: [{ ...keyboardQuestionnaire.questions[0]!, multiSelect: true }] }} interaction={interaction} onRespond={vi.fn()} />);
    screen.getByRole("checkbox", { name: "Fast" }).focus();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Safe" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    const last = screen.getByRole("checkbox", { name: "Balanced" });
    expect(last).toHaveFocus();
    expect(last).not.toBeChecked();
    await user.keyboard(" ");
    expect(last).toBeChecked();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Type something/ })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("checkbox", { name: "Fast" })).toHaveFocus();
    expect(last).toBeChecked();
    expect(screen.getAllByRole("checkbox").every((item) => item.tabIndex === 0)).toBe(true);
  });

  it("saves a custom answer on shortcut, but does not submit plain Enter or composing Enter", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={{ ...questionnaire, questions: [questionnaire.questions[0]!] }} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    const input = screen.getByRole("textbox", { name: "Your answer" });
    fireEvent.change(input, { target: { value: "Bespoke answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers[0]).toMatchObject({ kind: "custom", answer: "Bespoke answer" });
  });

  it("keeps the response for retry and locks editing while submitting", async () => {
    const onRespond = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
    render(<QuestionnairePrompt questionnaire={{ ...questionnaire, questions: [questionnaire.questions[0]!] }} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(screen.getByRole("radio", { name: "Fast" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Submitting…" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Offline"));
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond.mock.calls[0]).toEqual(onRespond.mock.calls[1]);
  });

  it.each(["", " \n "])("keeps a saved selection when an empty custom editor is left (%j)", (draft) => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={questionnaire} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tables" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radio", { name: "Fast" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers[0]).toMatchObject({ kind: "option", answer: "Fast" });
  });

  it("keeps saved multi-select answers when submitting with an empty custom editor", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={{ ...questionnaire, questions: [questionnaire.questions[1]!] }} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Figures" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tables" }));
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(JSON.parse(onRespond.mock.calls[0]![0].value).answers[0]).toMatchObject({ kind: "multi", selected: ["Figures", "Tables"] });
  });

  it("focuses and scrolls to the current unanswered question on every failed submit", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={{ ...questionnaire, questions: [questionnaire.questions[0]!] }} interaction={interaction} onRespond={onRespond} />);
    const heading = screen.getByRole("heading");
    const body = heading.closest("section")!.querySelector<HTMLElement>("header + div")!;
    const submit = screen.getByRole("button", { name: "Submit answers" });
    for (let attempt = 0; attempt < 2; attempt++) {
      body.scrollTop = 100;
      submit.focus();
      fireEvent.click(submit);
      expect(heading).toHaveFocus();
      expect(body.scrollTop).toBe(0);
      expect(screen.getByRole("alert")).toHaveTextContent("Please answer question 1");
    }
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("does not allow an empty custom answer and keeps cancellation explicit", () => {
    const onRespond = vi.fn();
    render(<QuestionnairePrompt questionnaire={{ ...questionnaire, questions: [questionnaire.questions[0]!] }} interaction={interaction} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel questionnaire" }));
    expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
  });
});
