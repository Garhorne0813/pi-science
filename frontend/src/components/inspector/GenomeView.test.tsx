import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { GenomeView } from "./GenomeView";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("observes the viewport after contig initialization so narrow views resize correctly", async () => {
  await i18n.changeLanguage("en");
  const observe = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect() {} });
  render(<GenomeView filename="sample.bed" text={"chr1\t0\t100\tgene"} />);
  expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
  await waitFor(() => expect(observe).toHaveBeenCalledOnce());
  expect(observe.mock.calls[0][0].querySelector("svg")).toBeInTheDocument();
});
