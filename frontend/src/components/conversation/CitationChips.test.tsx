import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { extractCitations } from "../../lib/citations";
import { CitationChips } from "./CitationChips";

const text = "References\n\n1. He, K. (2016). Deep residual learning for image recognition. CVPR. 10.1038/x";
/** A project that is not the directory the server runs in. */
const cwd = "/Users/someone/other-project";
const SNAPSHOT_URL = "/api/citations/snapshot?cwd=%2FUsers%2Fsomeone%2Fother-project";

const referenceEntry = "He, K. (2016). Deep residual learning for image recognition. CVPR.";

function snapshot(status: "found" | "unchecked") {
  return {
    citations: [{
      kind: "doi", id: "10.1038/x", status, title: "Attention Is All You Need", authors: ["Ashish Vaswani"],
      journal: null, year: "2017", retraction: "clear", retraction_note: null, retraction_url: null,
      checked_providers: status === "found" ? ["crossref"] : [], error: null, status_note: null,
      bibliographic: status === "found" ? "mismatch" : "not_compared", bibliographic_note: status === "found" ? referenceEntry : null,
      version: "not_applicable", requested_version: null, record_version: null, verified_at: status === "found" ? "2026-10-27T09:00:00.000Z" : "",
    }],
  };
}

/** Answers the settings read and then walks the snapshot answers in order,
 *  repeating the last one, so a poll sees the background verification land. */
function stubFetch(snapshots: unknown[], autoVerify = false): string[] {
  const calls: string[] = [];
  let index = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = url.startsWith("/api/settings/config") ? { ok: true, citation_auto_verify: autoVerify } : snapshots[Math.min(index++, snapshots.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const snapshotCalls = (calls: string[]) => calls.filter((url) => url.startsWith("/api/citations/snapshot")).length;

function renderChips() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CitationChips citations={extractCitations(text)} text={text} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { useRuntimeStore.setState({ cwd }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows a reference entry that contradicts the record and reads it for this workspace", async () => {
  const calls = stubFetch([snapshot("found")]);
  renderChips();

  expect(await screen.findByLabelText("Bibliographic mismatch")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("link").getAttribute("title")).toContain("Deep residual learning"));
  expect(calls).toContain(SNAPSHOT_URL);
});

it("polls while a source is unchecked and stops once the background verification lands", async () => {
  vi.useFakeTimers();
  const calls = stubFetch([snapshot("unchecked"), snapshot("found")], true);
  renderChips();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(snapshotCalls(calls)).toBe(1);

  // The settled turn's verification lands between two polls.
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(snapshotCalls(calls)).toBe(2);
  // React Query batches the completed fetch onto a timer of its own, so one
  // more tick is needed before the chip reads the new evidence.
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByLabelText("Bibliographic mismatch")).toBeInTheDocument();

  const settled = snapshotCalls(calls);
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  expect(snapshotCalls(calls)).toBe(settled);
});

it("does not poll while the automatic verification switch is off", async () => {
  vi.useFakeTimers();
  const calls = stubFetch([snapshot("unchecked")]);
  renderChips();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(snapshotCalls(calls)).toBe(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
  expect(snapshotCalls(calls)).toBe(1);
});
