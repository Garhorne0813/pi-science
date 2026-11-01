import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { numberCitations } from "../../lib/citations";
import { CitationRef } from "./CitationRef";
import { CitationNumberingProvider } from "./CitationNumbering";

const cwd = "/Users/someone/other-project";
const text = "Reported in 10.1000/alpha.";
const key = "doi:10.1000/alpha";

const evidence = {
  kind: "doi", id: "10.1000/alpha", status: "found", title: "A cited paper", authors: ["Ashish Vaswani", "Noam Shazeer"],
  journal: "JACS", year: "2017", volume: "12", issue: "3", pages: "100-110", abstract: "We describe the method.", oa_url: null,
  retraction: "retracted", retraction_note: "Retracted by the journal", retraction_url: null, checked_providers: ["crossref"], error: null,
  status_note: null, bibliographic: "not_compared", bibliographic_note: null, version: "not_applicable", requested_version: null, record_version: null,
  verified_at: "2026-10-27T09:00:00.000Z",
};

type Style = "number" | "identifier";

/** Answers the settings read (the inline citation style), the source read and
 *  the check action. `rows` is what a check returns, so a test can show the
 *  card changing after it was checked. */
function stubFetch(style: Style = "identifier", rows: unknown[] = [evidence]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const payload = url.startsWith("/api/settings/config") ? { citation_inline_style: style }
      : url.startsWith("/api/citations/verify") ? { citations: rows, total: rows.length, processed: rows.length, unprocessed: [] }
        : { citations: rows };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

function renderRef({ style = "identifier" as Style, children = "10.1000/alpha", document = text }: { style?: Style; children?: React.ReactNode; document?: string } = {}) {
  // Seeded so the style is known on the first render: the settings read is a
  // fetch, and a test that has to wait for it would be testing the fetch.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["settings", "config", cwd], { citation_inline_style: style });
  render(
    <QueryClientProvider client={client}>
      <CitationNumberingProvider numbering={numberCitations(document)}>
        <CitationRef href="https://doi.org/10.1000/alpha" citationKey={key}>{children}</CitationRef>
      </CitationNumberingProvider>
    </QueryClientProvider>,
  );
}

/** The trigger is the number; the region that opens the preview is what holds
 *  it, exactly as the pointer sees it. */
const trigger = () => screen.getByRole("button", { name: "References [1]" });
const hoverRegion = () => trigger().parentElement!;
const dialog = () => screen.queryByRole("dialog");
const enter = (element: Element) => fireEvent.pointerOver(element, { relatedTarget: document.body });
const leave = (element: Element, to: Element = document.body) => fireEvent.pointerOut(element, { relatedTarget: to });

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useRuntimeStore.setState({ cwd }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps the identifier the model wrote and adds the body number", () => {
  stubFetch();
  renderRef();
  expect(screen.getByRole("link", { name: "10.1000/alpha" })).toHaveAttribute("href", "https://doi.org/10.1000/alpha");
  expect(trigger()).toHaveAttribute("aria-expanded", "false");
  expect(dialog()).not.toBeInTheDocument();
});

it("opens a real dialog that contacts no provider and names the retraction separately", async () => {
  const calls = stubFetch();
  renderRef();
  fireEvent.click(trigger());

  expect(dialog()).toBeInTheDocument();
  expect(trigger()).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(screen.getByText("A cited paper")).toBeInTheDocument());
  expect(screen.getByText(/Retraction notice: Retracted by the journal/)).toBeInTheDocument();
  expect(screen.getByText("No locatable full text")).toBeInTheDocument();
  expect(screen.getByText(/does not show that the paper supports this claim/)).toBeInTheDocument();
  expect(calls.some((call) => call.url.startsWith("/api/citations/verify"))).toBe(false);
});

it("closes on Escape and hands focus back to the number that opened it", async () => {
  stubFetch();
  renderRef();
  fireEvent.click(trigger());
  expect(screen.getByRole("button", { name: "Close source card" })).toHaveFocus();

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  expect(trigger()).toHaveFocus();
});

it("checks only this source, and re-checks it past the cache", async () => {
  const calls = stubFetch();
  renderRef();
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.getByText("A cited paper")).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(calls.some((call) => call.url.startsWith("/api/citations/verify"))).toBe(true));
  const verify = calls.find((call) => call.url.startsWith("/api/citations/verify"))!;
  expect(verify.body).toEqual({ ids: [key], refresh: true });
});

it("keeps a hover preview open while the pointer moves from the number onto the card", async () => {
  stubFetch();
  renderRef();
  enter(hoverRegion());
  expect(dialog()).toBeInTheDocument();

  // The card is a portal, so leaving the number starts the close delay; the
  // card cancels it on the way in.
  leave(hoverRegion(), dialog()!);
  enter(dialog()!);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(dialog()).toBeInTheDocument();
});

it("closes a hover preview only after the pointer has been away for a moment", async () => {
  vi.useFakeTimers();
  stubFetch();
  renderRef();
  enter(hoverRegion());
  expect(dialog()).toBeInTheDocument();

  leave(hoverRegion());
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(dialog()).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(dialog()).not.toBeInTheDocument();
});

it("pins the card when the number is clicked while it is previewing, and keeps it pinned", async () => {
  vi.useFakeTimers();
  stubFetch();
  renderRef();
  enter(hoverRegion());
  expect(dialog()).toBeInTheDocument();

  fireEvent.click(trigger());
  expect(dialog()).toBeInTheDocument();
  expect(trigger()).toHaveAttribute("aria-expanded", "true");

  leave(hoverRegion());
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(dialog()).toBeInTheDocument();
});

it("closes a pinned card on a click outside it", async () => {
  stubFetch();
  renderRef();
  fireEvent.click(trigger());
  expect(dialog()).toBeInTheDocument();

  fireEvent.click(document.body);
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
});

it("keeps the card open while an inner button works", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  stubFetch();
  renderRef();
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.getByText("A cited paper")).toBeInTheDocument());

  fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]!);
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  expect(dialog()).toBeInTheDocument();
});

it("shows the answer a check returned instead of the state before it", async () => {
  const notFound = { ...evidence, status: "not_found", title: null, checked_providers: ["crossref"] };
  const calls = stubFetch("identifier", [notFound]);
  renderRef();
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.getByText("Not found in crossref")).toBeInTheDocument());
  expect(screen.queryByText("A cited paper")).not.toBeInTheDocument();

  // The retry answers with the record the first lookup missed.
  calls.length = 0;
  stubFetch("identifier", [evidence]);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByText("A cited paper")).toBeInTheDocument());
  expect(screen.queryByText("Not in the queried source", { selector: "p" })).not.toBeInTheDocument();
});

it("shows a failed lookup as a failure with a retry, never as a missing source", async () => {
  const failed = { ...evidence, status: "error", title: null, error: "crossref answered 503" };
  stubFetch("identifier", [failed]);
  renderRef();
  fireEvent.click(trigger());
  await waitFor(() => expect(screen.getByText(/Lookup failed: crossref answered 503/)).toBeInTheDocument());
  expect(screen.queryByText("Not found in crossref")).not.toBeInTheDocument();

  // The retry after a failure asks the provider again and shows what came back.
  stubFetch("identifier", [evidence]);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByText("A cited paper")).toBeInTheDocument());
  expect(screen.queryByText(/Lookup failed/)).not.toBeInTheDocument();
});

it("marks a check in flight while it runs", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/settings/config")) return new Response(JSON.stringify({ citation_inline_style: "identifier" }));
    if (url.startsWith("/api/citations/verify")) return new Promise<Response>(() => undefined);
    return new Response(JSON.stringify({ citations: [] }));
  }));
  renderRef();
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole("button", { name: "Check this source" }));
  // The badge and the check button both read "Checking" while the request runs.
  await waitFor(() => expect(screen.getByRole("button", { name: "Checking" })).toBeDisabled());
  expect(screen.getByText("Checking", { selector: "span" })).toBeInTheDocument();
});

it("reads as the number, linked to the resolver, under the number style", () => {
  stubFetch("number");
  renderRef({ style: "number" });
  const number = screen.getByRole("link", { name: "References [1]" });
  expect(number).toHaveAttribute("href", "https://doi.org/10.1000/alpha");
  expect(screen.queryByText("10.1000/alpha")).not.toBeInTheDocument();
});

it("keeps link text with its own words under the number style and adds the number", () => {
  stubFetch("number");
  renderRef({ style: "number", children: "the original paper" });
  expect(screen.getByRole("link", { name: "the original paper" })).toBeInTheDocument();
  expect(trigger()).toBeInTheDocument();
});

it("keeps the identifier and the number under the identifier style", () => {
  stubFetch("identifier");
  renderRef({ style: "identifier" });
  expect(screen.getByRole("link", { name: "10.1000/alpha" })).toBeInTheDocument();
  expect(trigger()).toBeInTheDocument();
});

it("reads as the number alone when the label carries a doi: scheme", () => {
  stubFetch("number");
  renderRef({ style: "number", children: "doi:10.1000/alpha" });
  expect(screen.getByRole("link", { name: "References [1]" })).toBeInTheDocument();
  expect(screen.queryByText(/doi:/i)).not.toBeInTheDocument();
});

it("keeps the whole identifier, scheme included, under the identifier style", () => {
  stubFetch("identifier");
  renderRef({ style: "identifier", children: "doi:10.1000/alpha" });
  expect(screen.getByRole("link", { name: "doi:10.1000/alpha" })).toBeInTheDocument();
  expect(trigger()).toBeInTheDocument();
});

it("treats a scheme with spaces as the identifier too", () => {
  stubFetch("number");
  renderRef({ style: "number", children: "DOI : 10.1000/alpha" });
  expect(screen.getByRole("link", { name: "References [1]" })).toBeInTheDocument();
});

it("keeps a label that mentions the scheme but says something else", () => {
  stubFetch("number");
  renderRef({ style: "number", children: "the DOI paper" });
  expect(screen.getByRole("link", { name: "the DOI paper" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "References [1]" })).not.toBeInTheDocument();
});

it("keeps the identifier when the document gives the source no number", () => {
  stubFetch("number");
  renderRef({ style: "number", document: "Nothing is cited here." });
  expect(screen.getByRole("link", { name: "10.1000/alpha" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "References [1]" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "References [1]" })).not.toBeInTheDocument();
});
