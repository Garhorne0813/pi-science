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
    onEditInComposer: vi.fn(async () => undefined),
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

const region = () => screen.queryByRole("region", { name: "Follow-up queue" });

describe("QueuedMessagesPanel", () => {
  it("shows the message with its server-side status", () => {
    renderPanel();
    expect(region()).toHaveTextContent("then summarize the table");
    expect(region()).toHaveTextContent("Queued");
  });

  it("hands a queued message to the composer instead of editing in place", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    await waitFor(() => expect(callbacks.onEditInComposer).toHaveBeenCalledWith(entry()));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("removes a queued message", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledWith(entry().id));
  });

  it("drops a dispatched message once the transcript carries it", () => {
    renderPanel({ entries: [entry({ status: "dispatched" })] });
    expect(region()).not.toBeInTheDocument();
  });

  it("drops a cancelled message instead of leaving a struck-out row", () => {
    renderPanel({ entries: [entry({ status: "cancelled" })] });
    expect(region()).not.toBeInTheDocument();
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

  it("counts only the receipts the panel still shows", () => {
    renderPanel({
      entries: [
        entry(),
        entry({ id: "0f5f1c0a-2b0d-4c9e-8a52-4d3a0f5d9e21", status: "dispatched", error_code: "indeterminate" }),
        entry({ id: "3c4c0c4e-6f0e-4f0e-9c1a-2b3d4e5f6a7b", status: "dispatched" }),
      ],
    });
    expect(screen.getByRole("button", { name: "Hide queued messages" })).toHaveTextContent("2 messages");
  });

  it("keeps the queued count while every message is still waiting", () => {
    renderPanel({
      entries: [
        entry(),
        entry({ id: "1a7d3e5b-6c84-4f92-b1d0-8e2c4a9f7b63", status: "dispatching" }),
      ],
    });
    expect(screen.getByRole("button", { name: "Hide queued messages" })).toHaveTextContent("2 queued");
  });

  it("keeps the paused banner even when no entry is visible", () => {
    renderPanel({ entries: [entry({ status: "dispatched" })], paused: true });
    expect(region()).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The queue is paused.");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("continues a manually paused queue", async () => {
    const callbacks = renderPanel({ paused: true });
    expect(screen.getByRole("status")).toHaveTextContent("The queue is paused.");
    fireEvent.click(screen.getByRole("button", { name: "Continue queue" }));
    await waitFor(() => expect(callbacks.onResume).toHaveBeenCalled());
  });
});
