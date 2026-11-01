import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { numberCitations } from "../../lib/citations";
import { CitationRef } from "./CitationRef";
import { CitationNumberingProvider } from "./CitationNumbering";

const cwd = "/Users/someone/other-project";
const text = "Reported in 10.1000/alpha.";

const evidence = {
  kind: "doi", id: "10.1000/alpha", status: "found", title: "A cited paper", authors: ["Ashish Vaswani", "Noam Shazeer"],
  journal: "JACS", year: "2017", abstract: null, oa_url: null, retraction: "retracted", retraction_note: "Retracted by the journal",
  retraction_url: null, checked_providers: ["crossref"], error: null, status_note: null, bibliographic: "not_compared",
  bibliographic_note: null, version: "not_applicable", requested_version: null, record_version: null, verified_at: "2026-10-27T09:00:00.000Z",
};

function stubFetch(): Array<{ url: string; body: unknown }> {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const payload = url.startsWith("/api/citations/verify") ? { citations: [evidence], total: 1, processed: 1, unprocessed: [] } : { citations: [evidence] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

function renderRef() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CitationNumberingProvider numbering={numberCitations(text)}>
        <CitationRef href="https://doi.org/10.1000/alpha" citationKey="doi:10.1000/alpha">10.1000/alpha</CitationRef>
      </CitationNumberingProvider>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByRole("button", { name: "References [1]" });

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useRuntimeStore.setState({ cwd }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the identifier the model wrote and adds the body number", () => {
  stubFetch();
  renderRef();
  expect(screen.getByRole("link", { name: "10.1000/alpha" })).toHaveAttribute("href", "https://doi.org/10.1000/alpha");
  expect(trigger()).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens a real dialog that contacts no provider and names the retraction separately", async () => {
  const calls = stubFetch();
  renderRef();
  fireEvent.click(trigger());

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toBeInTheDocument();
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
  await screen.findByRole("dialog");
  expect(screen.getByRole("button", { name: "Close source card" })).toHaveFocus();

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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
  expect(verify.body).toEqual({ ids: ["doi:10.1000/alpha"], refresh: true });
});
