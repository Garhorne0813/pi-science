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
  const callbacks = {
    onResume: vi.fn(async () => undefined),
    onEdit: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    onRetry: vi.fn(async () => undefined),
    onDispatch: vi.fn(async () => "accepted" as const),
  };
  const toast = vi.fn();
  render(
    <FeedbackContext.Provider value={{ toast, confirm: async () => true }}>
      <QueuedMessagesPanel entries={[entry()]} paused={false} {...callbacks} {...props} />
    </FeedbackContext.Provider>,
  );
  return { ...callbacks, toast };
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

  it("delivers a queued message immediately when asked", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() => expect(callbacks.onDispatch).toHaveBeenCalledWith(entry().id));
  });

  it("tells the user when a delivery could not be confirmed", async () => {
    const callbacks = renderPanel({ onDispatch: vi.fn(async () => "indeterminate" as const) });
    fireEvent.click(screen.getByRole("button", { name: "Deliver now" }));
    await waitFor(() =>
      expect(callbacks.toast).toHaveBeenCalledWith(
        "The message may not have reached the task.",
        "info",
      ),
    );
  });

  it("labels a dispatched message whose delivery was not confirmed", () => {
    renderPanel({ entries: [entry({ status: "dispatched", error_code: "indeterminate" })] });
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Sent, unconfirmed")).toBeInTheDocument();
  });

  it("retries a failed message and does not offer to edit it", async () => {
    const callbacks = renderPanel({
      entries: [entry({ status: "failed", error_code: "steer_failed" })],
    });
    expect(screen.queryByRole("button", { name: "Edit queued message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry queued message" }));
    await waitFor(() => expect(callbacks.onRetry).toHaveBeenCalledWith(entry().id));
  });

  it("collapses to a count and expands again", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Hide queued messages" }));
    expect(screen.queryByText("then summarize the table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show queued messages" })).toHaveTextContent("1 queued");
    fireEvent.click(screen.getByRole("button", { name: "Show queued messages" }));
    expect(screen.getByText("then summarize the table")).toBeInTheDocument();
  });

  it("continues a manually paused queue", async () => {
    const callbacks = renderPanel({ paused: true });
    expect(screen.getByRole("status")).toHaveTextContent("The queue is paused.");
    fireEvent.click(screen.getByRole("button", { name: "Continue queue" }));
    await waitFor(() => expect(callbacks.onResume).toHaveBeenCalled());
  });
});
