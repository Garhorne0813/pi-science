import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CitationSource } from "@pi-science/contracts";
import { CitationSources } from "./CitationSources";
import { resolveCitations } from "../../lib/citations/resolve";
import { useUiStore } from "../../lib/ui";
import i18n from "../../i18n";

function source(overrides: Partial<CitationSource> & Pick<CitationSource, "kind" | "identity">): CitationSource {
  return {
    id: `${overrides.kind}:${overrides.identity}`,
    title: overrides.identity,
    locator: { kind: "whole-source" },
    excerpt: null,
    capturedAt: "2026-11-02T02:00:00.000Z",
    evidence: { tool: overrides.kind === "web" ? "web_fetch" : "read", callId: "call-1", turnId: null },
    status: "verified",
    statusDetail: null,
    ...overrides,
  };
}

const originalOpenInspector = useUiStore.getState().openInspector;

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => {
  cleanup();
  useUiStore.setState({ openInspector: originalOpenInspector });
  vi.unstubAllGlobals();
});
afterAll(() => { useUiStore.setState({ openInspector: originalOpenInspector }); });

describe("CitationSources", () => {
  it("renders identifier, workspace file and web cards", () => {
    const text = "Results in results/table.csv, page https://example.org/report, doi:10.1000/abc, arXiv:2401.12345v2.";
    const citations = resolveCitations(text, [
      source({ kind: "file", identity: "results/table.csv", title: "table.csv", locator: { kind: "lines", startLine: 2, endLine: 4 }, excerpt: "a,b\n1,2\n3,4" }),
      source({ kind: "web", identity: "https://example.org/report", title: "example.org", locator: { kind: "chars", start: 0, end: 40 }, excerpt: "Report findings" }),
    ]);
    render(<CitationSources citations={citations} cwd="proj" sessionId="s1" />);
    expect(screen.getByText("Workspace file")).toBeInTheDocument();
    expect(screen.getByText("Web page")).toBeInTheDocument();
    expect(screen.getByText("DOI")).toBeInTheDocument();
    expect(screen.getByText("arXiv")).toBeInTheDocument();
    expect(screen.getByText("table.csv")).toBeInTheDocument();
    expect(screen.getByText("Lines 2-4")).toBeInTheDocument();
    expect(screen.getByText("Characters 0-40")).toBeInTheDocument();
    expect(screen.getByText("a,b 1,2 3,4")).toBeInTheDocument();
    expect(screen.getAllByText(/^Read /).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "example.org" })).toHaveAttribute("href", "https://example.org/report");
    expect(screen.getByRole("link", { name: "10.1000/abc" })).toHaveAttribute("href", "https://doi.org/10.1000/abc");
    expect(screen.getByRole("link", { name: "2401.12345v2" })).toHaveAttribute("href", "https://arxiv.org/abs/2401.12345v2");
  });

  it("labels every failed verification status", () => {
    const text = "a.csv b.csv c.csv d.csv";
    const citations = resolveCitations(text, [
      source({ kind: "file", identity: "a.csv", status: "changed", statusDetail: "changed detail" }),
      source({ kind: "file", identity: "b.csv", status: "missing" }),
      source({ kind: "file", identity: "c.csv", status: "forbidden" }),
      source({ kind: "file", identity: "d.csv", status: "unavailable" }),
    ]);
    render(<CitationSources citations={citations} />);
    expect(screen.getByText("Changed since read")).toBeInTheDocument();
    expect(screen.getByText("File missing")).toBeInTheDocument();
    expect(screen.getByText("Not allowed")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("changed detail")).toBeInTheDocument();
  });

  it("shows no evidence for an identifier-only source", () => {
    const citations = resolveCitations("doi:10.1000/abc", []);
    render(<CitationSources citations={citations} />);
    expect(screen.getByText("No read evidence")).toBeInTheDocument();
    expect(screen.queryByText(/Read /)).not.toBeInTheDocument();
  });

  it("never renders journal or retraction fields for workspace files", () => {
    const citations = resolveCitations("results/table.csv", [source({ kind: "file", identity: "results/table.csv", excerpt: "data" })]);
    render(<CitationSources citations={citations} cwd="proj" />);
    expect(screen.queryByText(/journal|retract|impact factor/i)).not.toBeInTheDocument();
  });

  it("opens a workspace file in the inspector without inventing a page", () => {
    const openInspector = vi.fn();
    useUiStore.setState({ openInspector });
    const chart = resolveCitations("results/table.csv", [source({ kind: "file", identity: "results/table.csv" })]);
    render(<CitationSources citations={chart} cwd="proj" />);
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(openInspector).toHaveBeenCalledWith({ variant: "file", path: "results/table.csv", filename: "table.csv", cwd: "proj" });
  });

  it("opens a PDF source without passing a page", () => {
    const openInspector = vi.fn();
    useUiStore.setState({ openInspector });
    const paper = resolveCitations("papers/draft.pdf", [source({ kind: "file", identity: "papers/draft.pdf", locator: { kind: "lines", startLine: 1, endLine: 9 } })]);
    render(<CitationSources citations={paper} cwd="proj" />);
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(openInspector).toHaveBeenCalledWith({ variant: "pdf", path: "papers/draft.pdf", filename: "draft.pdf" });
  });

  it("never fetches while rendering", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const citations = resolveCitations("results/table.csv doi:10.1000/abc", [source({ kind: "file", identity: "results/table.csv", excerpt: "data" })]);
    render(<CitationSources citations={citations} cwd="proj" sessionId="s1" />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
