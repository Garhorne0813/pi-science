import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import { ConversationInteractionDock } from "./ConversationInteractionDock";
import type { PendingInteraction, PendingQuestionnaire } from "../../lib/agent-runtime";

const interaction: PendingInteraction = { requestId: "request-1", toolCallId: "tool-1", questionnaire: true, method: "input", title: "Questionnaire" };
const questionnaire: PendingQuestionnaire = { toolCallId: "tool-1", questions: [
  { question: "Choose a mode", header: "Mode", multiSelect: false, options: [{ label: "Fast", description: "Quick", preview: "**Details**" }] },
  { question: "Choose outputs", header: "Outputs", multiSelect: true, options: [{ label: "Tables", description: "Data" }] },
] };
const form = () => screen.getByRole("region", { name: "Answer a few questions" });

describe("compact ConversationInteractionDock", () => {
  it("waits for a matching pair, never renders an actionable stale form, and removes expired prompts", () => {
    const props = { interaction, questionnaire, onRespond: vi.fn() };
    const view = render(<ConversationInteractionDock {...props} interaction={null} questionnaire={null} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<ConversationInteractionDock {...props} questionnaire={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing the question");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    view.rerender(<ConversationInteractionDock {...props} questionnaire={{ ...questionnaire, toolCallId: "other" }} />);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    view.rerender(<ConversationInteractionDock {...props} />);
    expect(form()).toBeInTheDocument();
    view.rerender(<ConversationInteractionDock {...props} interaction={null} questionnaire={null} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("preserves selections, custom drafts, notes and position through collapse and replay", () => {
    const props = { interaction, questionnaire, onRespond: vi.fn() };
    const view = render(<ConversationInteractionDock {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Notes for this question" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes for this question" }), { target: { value: "Keep my note" } });
    fireEvent.click(screen.getByRole("button", { name: /Type something/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Unfinished answer" } });
    const original = form();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(original).not.toBeVisible();
    expect(original).toBeInTheDocument();
    expect(props.onRespond).not.toHaveBeenCalled();
    view.rerender(<ConversationInteractionDock {...props} questionnaire={structuredClone(questionnaire)} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue answering/ }));
    expect(form()).toBe(original);
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("Unfinished answer");
    expect(screen.getByRole("textbox", { name: "Notes for this question" })).toHaveValue("Keep my note");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Choose outputs" })).toHaveFocus();
    fireEvent.keyDown(form(), { key: "Escape" });
    expect(screen.getByRole("button", { name: /Continue answering/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Continue answering/ }));
    expect(screen.getByRole("heading", { name: "Choose outputs" })).toHaveFocus();
    expect(props.onRespond).not.toHaveBeenCalled();
  });

  it("closes details with Escape first, then collapses without cancelling", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<ConversationInteractionDock interaction={interaction} questionnaire={questionnaire} onRespond={onRespond} />);
    await user.click(screen.getByRole("button", { name: "Preview Fast" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Details");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(form()).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Continue answering/ })).toBeVisible();
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("resets the compact form and collapse state for another request", () => {
    const props = { interaction, questionnaire, onRespond: vi.fn() };
    const view = render(<ConversationInteractionDock {...props} />);
    fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: /Continue answering/ })).toHaveTextContent("1 of 2 answered");
    view.rerender(<ConversationInteractionDock {...props} interaction={{ ...interaction, requestId: "new" }} />);
    expect(form()).toBeVisible();
    expect(screen.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "false");
  });

  it("does not steal focus from a separate visible editor", () => {
    const props = { interaction, questionnaire, onRespond: vi.fn() };
    const view = render(<><textarea aria-label="Editor" /><ConversationInteractionDock {...props} interaction={null} questionnaire={null} /></>);
    const editor = screen.getByRole("textbox", { name: "Editor" });
    editor.focus();
    view.rerender(<><textarea aria-label="Editor" /><ConversationInteractionDock {...props} /></>);
    expect(editor).toHaveFocus();
  });

  it("signals completion after a successful response", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();
    render(<ConversationInteractionDock interaction={interaction} questionnaire={questionnaire} onRespond={onRespond} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel questionnaire" }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onRespond).toHaveBeenCalledWith({ cancelled: true });
  });

  it("preserves permission allow/deny semantics within the shared seat", () => {
    const onRespond = vi.fn();
    render(<ConversationInteractionDock interaction={{ requestId: "permission", method: "confirm", kind: "permission", title: "Allow access?" }} questionnaire={null} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Continue answering/ }));
    fireEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(onRespond).toHaveBeenCalledWith({ confirmed: true });
  });
});
