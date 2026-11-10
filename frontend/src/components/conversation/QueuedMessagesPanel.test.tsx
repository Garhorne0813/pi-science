import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../i18n";
import { FeedbackContext } from "../feedback/feedback-context";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "8fd824aa-51d3-4f63-839c-09e021b7970b",
  text: "then summarize the table",
  status: "queued" as const,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function renderPanel(props: Partial<React.ComponentProps<typeof QueuedMessagesPanel>> = {}) {
  const callbacks = { onResume: vi.fn(async () => undefined), onEdit: vi.fn(async () => undefined), onCancel: vi.fn(async () => undefined) };
  render(
    <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
      <QueuedMessagesPanel entries={[entry()]} paused={false} {...callbacks} {...props} />
    </FeedbackContext.Provider>,
  );
  return callbacks;
}

describe("QueuedMessagesPanel", () => {
  it("shows the message with its server-side status", () => {
    renderPanel();
    const region = screen.getByRole("region", { name: "Follow-up queue" });
    expect(region).toHaveTextContent("then summarize the table");
    expect(region).toHaveTextContent("Queued");
  });

  it("edits a queued message through the composer contract", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    const textarea = screen.getByRole("textbox", { name: "Queued message text" });
    fireEvent.change(textarea, { target: { value: "changed text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callbacks.onEdit).toHaveBeenCalledWith(entry().id, "changed text"));
    expect(screen.queryByRole("textbox", { name: "Queued message text" })).not.toBeInTheDocument();
  });

  it("removes a queued message", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledWith(entry().id));
  });

  it("offers no edit or cancel once the message was dispatched", () => {
    renderPanel({ entries: [entry({ status: "dispatched" })] });
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit queued message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
  });

  it("continues a queue that a stop paused", async () => {
    const callbacks = renderPanel({ paused: true });
    expect(screen.getByRole("status")).toHaveTextContent("Queue paused after stopping the task.");
    fireEvent.click(screen.getByRole("button", { name: "Continue queue" }));
    await waitFor(() => expect(callbacks.onResume).toHaveBeenCalled());
  });
});
