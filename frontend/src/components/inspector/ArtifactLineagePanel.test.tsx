import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArtifactLineagePanel } from "./ArtifactLineagePanel";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 2, artifact_id: "a2", version: 2, path: "clean.csv", kind: "table",
  mime: "text/csv", size: 10, sha256: "1234567890abcdef", published_at: "2026-01-01T00:00:00.000Z",
  inputs: [], supersedes: null, classification: "deliverable", ...overrides,
});

let lineageMode: "ok" | "not-found" | "unavailable" = "ok";

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/artifacts?") && url.includes("latest=1")) {
    if (lineageMode === "not-found") return jsonResponse({ artifacts: [] });
    return jsonResponse({ artifacts: [manifest()] });
  }
  if (/\/api\/artifacts\/[^/]+\?cwd=/.test(url)) {
    // Exact-manifest fetch (version-targeted opens).
    if (lineageMode === "not-found") return jsonResponse({ error: "Artifact not found" }, 404);
    return jsonResponse(manifest());
  }
  if (url.includes("/lineage")) {
    if (lineageMode === "unavailable") return jsonResponse({ error: "boom" }, 500);
    return jsonResponse({
      artifact: manifest(),
      upstream: [
        { kind: "consumes", artifact: manifest({ artifact_id: "a1", version: 1, path: "raw.csv", classification: "intermediate" }) },
        { kind: "supersedes", artifact: manifest({ artifact_id: "a2", version: 1, path: "clean.csv" }) },
      ],
      downstream: [
        { kind: "consumed_by", artifact: manifest({ artifact_id: "a3", version: 1, path: "final.csv" }) },
      ],
      unresolved_inputs: ["legacy/old.csv"],
    });
  }
  return jsonResponse({ error: `unhandled ${url}` }, 404);
});

function renderPanel() {
  return render(<ArtifactLineagePanel path="clean.csv" cwd="proj" />);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  lineageMode = "ok";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
  useRuntimeStore.setState({ cwd: "proj" });
  useUiStore.setState({ inspectorOpen: false, inspectorData: null, inspectorTabs: [], activeInspectorTabId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArtifactLineagePanel", () => {
  it("shows classification, exact versions and grouped relations", async () => {
    renderPanel();
    expect(await screen.findByText("Deliverable")).toBeInTheDocument();
    expect(screen.getByText("Inputs & supersedes")).toBeInTheDocument();
    expect(screen.getByText("Dependents")).toBeInTheDocument();

    // Exact version chips next to each related artifact.
    expect(screen.getByText("raw.csv")).toBeInTheDocument();
    expect(screen.getByText("final.csv")).toBeInTheDocument();
    expect(screen.getAllByText(/v\d/).length).toBeGreaterThanOrEqual(3);
  });

  it("marks legacy string inputs as unresolved", async () => {
    renderPanel();
    expect(await screen.findByText("Unresolved inputs")).toBeInTheDocument();
    expect(screen.getByText("legacy/old.csv")).toBeInTheDocument();
  });

  it("opens the related artifact at its exact version, not the live file", async () => {
    renderPanel();
    const row = await screen.findByTitle("Consumes this version");
    fireEvent.click(row);
    const inspector = useUiStore.getState().inspectorData as { path?: string; artifactVersion?: { artifact_id: string; version: number } } | null;
    expect(inspector?.path).toBe("raw.csv");
    expect(inspector?.artifactVersion).toEqual({ artifact_id: "a1", version: 1 });
  });

  it("pins the lineage to an exact version when artifactId/version are provided", async () => {
    render(<ArtifactLineagePanel path="clean.csv" cwd="proj" artifactId="a2" version={2} />);
    expect(await screen.findByText("Deliverable")).toBeInTheDocument();
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    // Exact fetch: the manifest and the lineage both carry version=2; the
    // path-based latest=1 resolution is not used.
    expect(calls.some((url) => url.includes("/api/artifacts/a2?cwd=proj&version=2"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/artifacts/a2/lineage?cwd=proj&version=2"))).toBe(true);
    expect(calls.some((url) => url.includes("latest=1"))).toBe(false);
  });

  it("renders nothing when the file has no artifact manifest", async () => {
    lineageMode = "not-found";
    renderPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Deliverable")).not.toBeInTheDocument();
    expect(screen.queryByText("Lineage")).not.toBeInTheDocument();
  });

  it("renders nothing when the lineage endpoint fails", async () => {
    lineageMode = "unavailable";
    renderPanel();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/lineage"))).toBe(true));
    expect(screen.queryByText("Deliverable")).not.toBeInTheDocument();
    expect(screen.queryByText("Lineage")).not.toBeInTheDocument();
  });

  it("rejects 5xx lineage errors so React Query retries them", async () => {
    lineageMode = "unavailable";
    renderPanel();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/lineage")).length).toBeGreaterThanOrEqual(2));
    // After the retries fail the panel renders nothing instead of a fake graph.
    await waitFor(() => expect(screen.queryByText("Deliverable")).not.toBeInTheDocument());
    expect(screen.queryByText("Lineage")).not.toBeInTheDocument();
  });

  it("does not retry 404 lineage lookups", async () => {
    lineageMode = "not-found";
    renderPanel();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("latest=1"))).toBe(true));
    // The not-found result is a resolved value, not a rejection: no retry.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("latest=1") || String(url).includes("/lineage")).length).toBe(1);
    expect(screen.queryByText("Lineage")).not.toBeInTheDocument();
  });

  it("refetches the lineage when the file revision signal bumps (turn settled with file changes)", async () => {
    renderPanel();
    await screen.findByText("Deliverable");
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/lineage")).length;
    expect(before).toBeGreaterThanOrEqual(1);

    // A settled turn with workspace file changes bumps fileRevision; the query
    // key includes it, so the lineage refetches (artifact.published may have
    // added manifests).
    act(() => { useRuntimeStore.setState({ fileRevision: (useRuntimeStore.getState().fileRevision ?? 0) + 1 }); });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/lineage")).length).toBeGreaterThan(before));
  });

  it("renders review verdicts attached to the artifact manifest", async () => {
    lineageMode = "ok";
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/artifacts?") && url.includes("latest=1")) {
        return jsonResponse({ artifacts: [manifest()] });
      }
      if (url.includes("/lineage")) {
        return jsonResponse({
          artifact: manifest({
            reviews: [
              { review_id: "r1", actor: "reviewer", status: "needs_work", at: "2026-08-14T00:00:00.000Z" },
              { review_id: "r2", actor: "pi", status: "passed", at: "2026-08-14T01:00:00.000Z" },
            ],
          }),
          upstream: [], downstream: [], unresolved_inputs: [],
        });
      }
      return jsonResponse({ error: `unhandled ${url}` }, 404);
    });
    renderPanel();
    await screen.findByText("Review");
    expect(screen.getByText("passed")).toBeTruthy();
    expect(screen.getByText("needs work")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("pi")).toBeTruthy();
  });
});
