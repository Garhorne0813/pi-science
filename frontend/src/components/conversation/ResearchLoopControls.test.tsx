import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { ResearchModePicker } from "./ResearchLoopControls";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ResearchModePicker", () => {
  it("renders a compact button row", () => {
    render(<ResearchModePicker selected={null} onSelect={vi.fn()} />);

    expect(screen.getByLabelText("Conversation mode")).toHaveClass("pb-1");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveClass("h-7", "min-h-0");
    }
  });
});
