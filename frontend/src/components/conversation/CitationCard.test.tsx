import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { CitationEvidence } from "../../lib/citations/citation-evidence";
import { CitationCard } from "./CitationCard";

const cwd = "/Users/someone/other-project";

const evidence: CitationEvidence = {
  kind: "doi", id: "10.1000/alpha", status: "found", title: "A cited paper", authors: ["Ashish Vaswani", "Noam Shazeer"],
  journal: "JACS", year: "2017", volume: "12", issue: "3", pages: "100-110", abstract: "We describe the method.",
  oa_url: null, retraction: "clear", retraction_note: null, retraction_url: null, checked_providers: ["crossref"], error: null,
  status_note: null, bibliographic: "not_compared", bibliographic_note: null, version: "not_applicable", requested_version: null,
  record_version: null, verified_at: "2026-10-27T09:00:00.000Z",
};

/** The card is a dialog anchored to the number that opened it, so the test
 *  renders the number beside it and lets the card close itself. */
function Harness({ row, focusOnOpen = false }: { row: CitationEvidence | undefined; focusOnOpen?: boolean }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  return <>
    <button ref={trigger} type="button">References [1]</button>
    {open && <CitationCard
      id="source-card"
      citationKey="doi:10.1000/alpha"
      evidence={row}
      focusOnOpen={focusOnOpen}
      trigger={trigger}
      onPointerEnter={() => undefined}
      onPointerLeave={() => undefined}
      onClose={() => setOpen(false)}
    />}
  </>;
}

function renderCard(row: CitationEvidence | undefined = evidence, focusOnOpen = false) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness row={row} focusOnOpen={focusOnOpen} /></QueryClientProvider>);
}

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useRuntimeStore.setState({ cwd }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows the volume, issue and pages the record carries", () => {
  renderCard();
  expect(screen.getByText("12(3): 100-110")).toBeInTheDocument();
});

it("omits a volume, issue or page the record does not carry instead of inventing one", () => {
  renderCard({ ...evidence, volume: null, issue: null, pages: "100-110" });
  expect(screen.getByText("100-110")).toBeInTheDocument();
  expect(screen.queryByText(/null|undefined|\(\)/)).not.toBeInTheDocument();

  cleanup();
  renderCard({ ...evidence, volume: null, issue: null, pages: null });
  expect(screen.queryByText(/null|undefined/)).not.toBeInTheDocument();
  expect(screen.queryByText(/100-110/)).not.toBeInTheDocument();
});

it("keeps the abstract behind a labelled preview that says what an abstract proves", () => {
  renderCard();
  const summary = screen.getByText("Paper abstract (preview)");
  expect(summary).toBeInTheDocument();
  expect(summary.closest("details")).toContainElement(screen.getByText("We describe the method."));
  expect(screen.getByText(/does not show that the paper supports the sentence citing it/)).toBeInTheDocument();
});

it("offers GB/T 7714 and APA text, each with its own copy action", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderCard();
  expect(screen.getByText("GB/T 7714")).toBeInTheDocument();
  expect(screen.getByText("APA 7th edition")).toBeInTheDocument();
  expect(screen.getByText(/A cited paper\[J\]\. JACS, 2017, 12\(3\), 100-110\. DOI: 10\.1000\/alpha\./)).toBeInTheDocument();
  expect(screen.getByText(/Vaswani, A\., & Shazeer, N\. \(2017\)\. A cited paper\. JACS, 12\(3\), 100-110\. https:\/\/doi\.org\/10\.1000\/alpha/)).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]!);
  expect(await screen.findByText("Copied")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("https://doi.org/10.1000/alpha"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("shows no formatted reference for a record that holds nothing to cite", () => {
  renderCard({ ...evidence, status: "unchecked", title: null, authors: [], journal: null, year: null, volume: null, issue: null, pages: null });
  expect(screen.queryByText("GB/T 7714")).not.toBeInTheDocument();
  expect(screen.queryByText("APA 7th edition")).not.toBeInTheDocument();
  expect(screen.getByText("Not checked")).toBeInTheDocument();
});

it("names a failed lookup as a failure, not as a source that does not exist", () => {
  renderCard({ ...evidence, status: "error", title: null, error: "crossref answered 503" });
  expect(screen.getByText("Lookup failed")).toBeInTheDocument();
  expect(screen.getByText(/Lookup failed: crossref answered 503/)).toBeInTheDocument();
  expect(screen.queryByText("Not in the queried source")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
});

it("names a missing source without claiming the lookup failed", () => {
  renderCard({ ...evidence, status: "not_found", title: null });
  expect(screen.getByText("Not in the queried source")).toBeInTheDocument();
  expect(screen.getByText("Not found in crossref")).toBeInTheDocument();
  expect(screen.queryByText(/Lookup failed/)).not.toBeInTheDocument();
});

/** The status chip carries its text on a solid fill. `*-fill` and `*-text` are
 *  two different roles and the light theme gives them the same value, so using
 *  one as the other's ink renders the word the same colour as the fill it sits
 *  on. jsdom has no cascade, so the class list is the closest observable. */
it("gives the status badge ink that can be read on its own fill", () => {
  renderCard();
  const badge = screen.getByText("Source metadata found");
  const classes = badge.className.split(/\s+/);
  for (const role of ["ok", "warn", "error"]) {
    if (!classes.includes(`bg-${role}-fill`)) continue;
    expect(classes).not.toContain(`text-${role}-text`);
    expect(classes).toContain("text-white");
  }
});

it("does not take focus away from the answer when a hover preview opens", () => {
  renderCard(evidence, false);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close source card" })).not.toHaveFocus();
});

it("takes focus on the close button when a click opened the card", () => {
  renderCard(evidence, true);
  expect(screen.getByRole("button", { name: "Close source card" })).toHaveFocus();
});

it("closes on Escape and gives focus back to the number", () => {
  renderCard(evidence, true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "References [1]" })).toHaveFocus();
});

it("closes on a click outside the card", () => {
  renderCard(evidence, true);
  fireEvent.click(document.body);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("stays open when the number itself is clicked", () => {
  renderCard(evidence, true);
  fireEvent.click(screen.getByRole("button", { name: "References [1]" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("gives focus back to the number when its own close button closes it", () => {
  renderCard(evidence, true);
  fireEvent.click(screen.getByRole("button", { name: "Close source card" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "References [1]" })).toHaveFocus();
});
