import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeedbackProvider } from "./FeedbackProvider";
import { useFeedback } from "./feedback-context";
import i18n from "../../i18n";

function renderProbe() {
  const confirmSpy = vi.fn();
  function Probe() {
    const { confirm } = useFeedback();
    return (
      <button type="button" onClick={() => void confirm({ title: "Delete?", message: "Really?", confirmLabel: "Delete" }).then(confirmSpy)}>
        open
      </button>
    );
  }
  render(
    <FeedbackProvider>
      <Probe />
    </FeedbackProvider>,
  );
  return { confirmSpy };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("FeedbackProvider confirm", () => {
  it("cancels on Escape and resolves false", async () => {
    const { confirmSpy } = renderProbe();
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith(false));
  });

  it("restores focus to the trigger element after Escape", () => {
    renderProbe();
    const trigger = screen.getByRole("button", { name: "open" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("does nothing on Escape while no confirmation is open", () => {
    renderProbe();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
