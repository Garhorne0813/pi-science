import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import type { CitationEvidence } from "../../lib/citations/citation-evidence";
import type { CitationExcerpt, CitationPosition } from "../../lib/citations/citation-passages";
import { CitationCard } from "./CitationCard";

const cwd = "/Users/someone/other-project";
const claim = "AlphaFold reached near-experimental accuracy on CASP14.";

const evidence: CitationEvidence = {
  kind: "doi", id: "10.1000/alpha", status: "found", title: "A cited paper", authors: ["Ashish Vaswani"], journal: "JACS", year: "2017",
  volume: "12", issue: "3", pages: "100-110", abstract: null, oa_url: "https://example.org/paper.pdf", retraction: "clear", retraction_note: null,
  retraction_url: null, checked_providers: ["crossref"], error: null, status_note: null, bibliographic: "not_compared", bibliographic_note: null,
  version: "not_applicable", requested_version: null, record_version: null, verified_at: "2026-10-27T09:00:00.000Z",
};

const excerpt: CitationExcerpt = {
  text: "AlphaFold reached near-experimental accuracy in CASP14.",
  before: "METHODS. We trained a neural network.",
  after: "The remaining gap is in loop regions.",
  section_title: "Results",
  section_id: "sec-results",
  page: 7,
  score: 12.5,
  passage_id: "p3",
};

function position(state: CitationPosition["state"], excerpts: CitationExcerpt[] = [], note: string | null = null): CitationPosition {
  return { key: "doi:10.1000/alpha", claim_sha256: "abc", state, note, snapshot_sha256: "sha", snapshot_id: "snap-1", origin: "generation", excerpts };
}

/** Answers the settings read, the source read, the snapshot read and the
 *  passage lookup, and records every passage request so a test can assert what
 *  the caller asked for. */
function stubFetch(result: CitationPosition = position("matched", [excerpt])) {
  const passages: Array<{ url: string; body: { fetch?: boolean; positions: Array<{ key: string; claim: string }> } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    // A snapshot-only read answers `unfetched` for anything not already on
    // disk, which is exactly what the card has to show on hover.
    const answered = url.startsWith("/api/citations/passages") && body?.fetch === false && result.state === "matched" ? position("unfetched") : result;
    const payload = url.startsWith("/api/settings/config") ? { citation_inline_style: "identifier" }
      : url.startsWith("/api/citations/passages") ? (passages.push({ url, body }), { positions: [answered] })
        : url.startsWith("/api/citations/verify") ? { citations: [evidence], total: 1, processed: 1, unprocessed: [] }
          : { citations: [evidence] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return passages;
}

function Harness({ pinned, row = evidence }: { pinned: boolean; row?: CitationEvidence }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  return <>
    <button ref={trigger} type="button">References [1]</button>
    {open && <CitationCard
      id="source-card"
      citationKey="doi:10.1000/alpha"
      claim={claim}
      evidence={row}
      focusOnOpen={pinned}
      trigger={trigger}
      onPointerEnter={() => undefined}
      onPointerLeave={() => undefined}
      onClose={() => setOpen(false)}
    />}
  </>;
}

function renderCard(pinned = true, row: CitationEvidence = evidence) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness pinned={pinned} row={row} /></QueryClientProvider>);
}

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useRuntimeStore.setState({ cwd }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("sends the sentence the marker sits in, never the whole answer", async () => {
  const passages = stubFetch();
  renderCard();
  await waitFor(() => expect(passages).toHaveLength(1));
  expect(passages[0]!.body.positions).toEqual([{ key: "doi:10.1000/alpha", claim }]);
});

it("names the session so a recorded passage can be found", async () => {
  const passages = stubFetch();
  useRuntimeStore.setState({ cwd, activeSessionId: "session-a" });
  renderCard();
  await waitFor(() => expect(passages).toHaveLength(1));
  expect((passages[0]!.body as { session_id?: string }).session_id).toBe("session-a");
});

it("says when the passage was found after the fact instead of chosen", async () => {
  stubFetch({ ...position("matched", [excerpt]), origin: "located" });
  renderCard();
  await waitFor(() => expect(screen.getByText("Relevant passage found after the fact")).toBeInTheDocument());
  expect(screen.queryByText("Passage the answer selected when it was written")).not.toBeInTheDocument();
});

it("reports a recorded passage that no longer resolves instead of quoting new text", async () => {
  stubFetch(position("stale"));
  renderCard();
  await waitFor(() => expect(screen.getByText(/recorded passage no longer resolves/)).toBeInTheDocument());
  expect(screen.queryByText(excerpt.text)).not.toBeInTheDocument();
});

it("does not fetch a provider when a hover preview opened the card", async () => {
  const passages = stubFetch();
  renderCard(false);
  await waitFor(() => expect(passages).toHaveLength(1));
  expect(passages[0]!.body.fetch).toBe(false);
  await waitFor(() => expect(screen.getByText("Full text not fetched yet")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Fetch the full text" })).toBeInTheDocument();
});

it("fetches once the reader clicks the number", async () => {
  const passages = stubFetch();
  renderCard(true);
  await waitFor(() => expect(passages).toHaveLength(1));
  expect(passages[0]!.body.fetch).toBe(true);
});

it("shows the located passage as the card's main content, with its context", async () => {
  stubFetch();
  renderCard();
  await waitFor(() => expect(screen.getByText("Passage the answer selected when it was written")).toBeInTheDocument());
  const mark = screen.getByText(excerpt.text);
  expect(mark.tagName).toBe("MARK");
  expect(screen.getByText(/We trained a neural network/)).toBeInTheDocument();
  expect(screen.getByText(/The remaining gap is in loop regions/)).toBeInTheDocument();
  expect(screen.getByText(/Results · file page 7/)).toBeInTheDocument();
  // The caveat sits beside the excerpt, not in the detail block: a located
  // passage is not a judgement that it supports the sentence.
  expect(screen.getByText(/not a judgement that it supports this sentence/)).toBeInTheDocument();
});

it("opens the source viewer on the passage, highlights it, and goes back", async () => {
  stubFetch();
  renderCard();
  await waitFor(() => expect(screen.getByRole("button", { name: "Show the source" })).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Show the source" }));
  expect(screen.getByRole("button", { name: "Back to the citation" })).toBeInTheDocument();
  expect(screen.getAllByText(excerpt.text).some((node) => node.tagName === "MARK")).toBe(true);
  expect(screen.getByRole("link", { name: /Open the original source/ })).toHaveAttribute("href", "https://doi.org/10.1000/alpha");

  fireEvent.click(screen.getByRole("button", { name: "Back to the citation" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Back to the citation" })).not.toBeInTheDocument());
  // The card is still open behind the viewer it belonged to.
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  // The viewer names the passage's origin the same way the card did.
  expect(screen.getByText("Passage the answer selected when it was written")).toBeInTheDocument();
});

it("offers every candidate passage in the viewer", async () => {
  const second: CitationExcerpt = { ...excerpt, text: "CASP14 targets were mostly single domains.", section_title: "Discussion", section_id: "sec-discussion", page: 9 };
  stubFetch(position("matched", [excerpt, second]));
  renderCard();
  await waitFor(() => expect(screen.getByRole("button", { name: "Show the source" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Show the source" }));

  fireEvent.click(screen.getByRole("tab", { name: "Passage 2" }));
  expect(screen.getAllByText(second.text).some((node) => node.tagName === "MARK")).toBe(true);
});

it("names each reason there is no passage instead of showing a made-up one", async () => {
  const cases: Array<[CitationPosition["state"], string]> = [
    ["no_match", "No passage in this source matches this sentence"],
    ["no_open_fulltext", "No open full text available for this source"],
    ["access_denied", "The source refused access to its full text"],
    ["parse_failed", "The full text arrived but nothing could be read from it"],
    ["no_text_layer", "This PDF has no readable text layer"],
    ["version_mismatch", "The full text available is a different version from the one cited"],
  ];
  for (const [state, message] of cases) {
    stubFetch(position(state));
    renderCard();
    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.queryByText("Located in the source")).not.toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
  }
});

it("says a download failed and offers to try again", async () => {
  const passages = stubFetch(position("download_failed", [], "HTTP 503"));
  renderCard();
  await waitFor(() => expect(screen.getByText(/The full text could not be downloaded: HTTP 503/)).toBeInTheDocument());
  expect(passages).toHaveLength(1);
});

it("says there is no locatable full text when the record has no open copy", async () => {
  stubFetch(position("no_open_fulltext"));
  renderCard(true, { ...evidence, oa_url: null });
  await waitFor(() => expect(screen.getByText("No open full text available for this source")).toBeInTheDocument());
});

it("keeps the reference list's own read out of the passage request", async () => {
  const passages = stubFetch();
  renderCard();
  await waitFor(() => expect(passages).toHaveLength(1));
  expect(passages[0]!.url).toContain("/api/citations/passages");
  expect(passages[0]!.body.positions).toHaveLength(1);
});
