import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageActions } from "./MessageActions";
import i18n from "../../i18n";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("MessageActions", () => {
  it("copies the message text", async () => {
    render(<MessageActions text="hello" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("renders no copy button when the text is empty (bookmark-only row)", () => {
    render(<MessageActions text="" bookmark={{ status: "accepted", onToggle: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove bookmark" })).toBeInTheDocument();
  });

  it("does not render a bookmark button without a bookmark prop", () => {
    render(<MessageActions text="hello" />);
    expect(screen.queryByRole("button", { name: /bookmark/i })).not.toBeInTheDocument();
  });

  it("labels accepted, proposed and none states and toggles on click", () => {
    const onToggle = vi.fn();
    const view = render(<MessageActions text="hello" bookmark={{ status: "none", onToggle }} />);
    fireEvent.click(screen.getByRole("button", { name: "Bookmark message" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.rerender(<MessageActions text="hello" bookmark={{ status: "accepted", onToggle }} />);
    expect(screen.getByRole("button", { name: "Remove bookmark" })).toBeInTheDocument();
    view.rerender(<MessageActions text="hello" bookmark={{ status: "proposed", onToggle }} />);
    expect(screen.getByRole("button", { name: "Accept bookmark proposal" })).toBeInTheDocument();
  });

  it("renders a proposed bookmark with a distinct pending style", () => {
    render(<MessageActions text="hello" bookmark={{ status: "proposed", onToggle: vi.fn() }} />);
    const button = screen.getByRole("button", { name: "Accept bookmark proposal" });
    expect(button.className).toContain("text-warn");
    expect(button.className).not.toContain("text-accent");
  });
});
