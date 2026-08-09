import { render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Icon, IconButton } from "./Icon";

describe("Icon", () => {
  it("applies the shared optical size and stroke width", () => {
    const { container } = render(<Icon icon={Settings} size="sm" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "14");
    expect(svg).toHaveAttribute("stroke-width", "1.75");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("gives icon-only controls an accessible name and stable hit box", () => {
    render(<IconButton icon={Settings} label="Settings" size="compact" />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button).toHaveClass("h-icon", "w-icon");
    expect(button.querySelector("svg")).toHaveAttribute("width", "14");
  });
});
