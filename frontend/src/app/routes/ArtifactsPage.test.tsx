import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ArtifactsPage } from "./ArtifactsPage";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../lib/client/query-client";
import { useRuntimeStore } from "../../lib/agent-runtime";
import i18n from "../../i18n";

vi.mock("../../lib/workspace", () => ({
  useRequiredWorkspaceCwd: () => "proj",
}));

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  WorkspacePageHeader: ({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <div>{title}</div>
      {description}
      {actions}
    </div>
  ),
  WorkspacePageRefreshButton: ({ label, onClick }: { label: string; onClick: () => void }) => <button onClick={onClick}>{label}</button>,
}));

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 2, artifact_id: "a1", version: 1, path: "results/plot.png", kind: "image",
  mime: "image/png", size: 2048, sha256: "1234567890abcdef", published_at: "2026-01-01T00:00:00.000Z",
  inputs: [], supersedes: null, classification: "deliverable", ...overrides,
});

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/artifacts?")) {
    return new Response(JSON.stringify({ artifacts: [
      manifest({ artifact_id: "a1", version: 2, path: "results/plot.png", reviews: [{ review_id: "r1", actor: "reviewer", status: "passed", at: "2026-01-02T00:00:00.000Z" }] }),
      manifest({ artifact_id: "a1", version: 1, path: "results/plot.png" }),
      manifest({ artifact_id: "a2", version: 1, path: "notes/draft.md", classification: "intermediate" }),
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "unhandled " + url }), { status: 404 });
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  useRuntimeStore.setState({ cwd: "proj" });
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArtifactsPage", () => {
  it("groups artifacts by identity and shows classification and review verdicts", async () => {
    render(<QueryClientProvider client={queryClient}><ArtifactsPage /></QueryClientProvider>);
    await screen.findByText("results/plot.png");
    expect(screen.getByText("notes/draft.md")).toBeTruthy();
    expect(screen.getByText("reviewed")).toBeTruthy();
    // v2 count chip for the multi-version entry.
    expect(screen.getByText("2 v")).toBeTruthy();
  });

  it("filters by classification", async () => {
    render(<QueryClientProvider client={queryClient}><ArtifactsPage /></QueryClientProvider>);
    await screen.findByText("results/plot.png");
    const deliverableFilter = screen.getByText("Deliverables");
    deliverableFilter.click();
    await waitFor(() => expect(screen.queryByText("notes/draft.md")).toBeNull());
    expect(screen.getByText("results/plot.png")).toBeTruthy();
  });

  it("expands version history", async () => {
    render(<QueryClientProvider client={queryClient}><ArtifactsPage /></QueryClientProvider>);
    await screen.findByText("results/plot.png");
    screen.getByText("results/plot.png").click();
    await screen.findByText("v2");
    expect(screen.getByText("v1")).toBeTruthy();
  });
});
