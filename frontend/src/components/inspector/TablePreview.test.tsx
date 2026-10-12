import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TablePreview } from "./TablePreview";
import i18n from "@/i18n";
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);
it("aligns numeric columns including scientific notation and visibly reports truncation", () => {
  render(<TablePreview table={{ columns: ["sample", "value"], rows: [["A", "-1.2e-3"], ["B", "0"]], truncated: true }} />);
  expect(screen.getByRole("columnheader", { name: "value" })).toHaveClass("text-right");
  expect(screen.getByRole("cell", { name: "-1.2e-3" })).toHaveClass("text-right", "font-mono");
  expect(screen.getByRole("cell", { name: "A" })).toHaveClass("text-left");
  expect(screen.getByRole("status")).toHaveTextContent(/2/);
});
