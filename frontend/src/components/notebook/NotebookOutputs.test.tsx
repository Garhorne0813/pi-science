import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { i18nReady } from "../../i18n";
import { StoredOutputs } from "./NotebookOutputs";

const png = (value: string) => ({ output_type: "display_data", data: { "image/png": value } });

describe("StoredOutputs", () => {
  it("gives each rich output in one cell a distinct accessible name", async () => {
    await i18nReady;
    render(<StoredOutputs outputs={[png("Zmlyc3Q="), png("c2Vjb25k")]} />);
    expect(screen.getByAltText("Output 1")).toBeInTheDocument();
    expect(screen.getByAltText("Output 2")).toBeInTheDocument();
  });
  it("keeps the plain label when the cell has a single rich output", async () => {
    await i18nReady;
    render(<StoredOutputs outputs={[png("c29sbw==")]} />);
    expect(screen.getByAltText("Output")).toBeInTheDocument();
  });
});
