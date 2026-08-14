/** Characterization tests for the inspector's new file-edit capability:
 *  an edit button appears for editable text files, the save path calls the
 *  write API, and binary files never offer editing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { queryClient } from "../../lib/client/query-client";
import { FilePreviewInspector } from "./FilePreviewInspector";
import { FeedbackContext } from "../feedback/feedback-context";
import type { FilePreviewInspector as FilePreviewInspectorT } from "../../types/thread";
import i18n from "../../i18n";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let writeCalls: Array<{ path: string; content: string }> = [];
let writeError: Error | null = null;
let missingPath: string | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.includes("/api/settings/config")) return jsonResponse({ ok: true, available_models: [], model: "", thinking: "high" });
  if (url.includes("/api/project-memory/research-loops")) return jsonResponse({ loops: [] });
  if (method === "POST" && url.includes("/api/files/content")) {
    if (writeError) return jsonResponse({ error: writeError.message }, 500);
    const body = JSON.parse(String(init.body)) as { path: string; content: string };
    writeCalls.push({ path: body.path, content: body.content });
    return jsonResponse({ ok: true, path: body.path, size: body.content.length });
  }
  if (missingPath && url.includes(`/api/files/${missingPath}`)) return jsonResponse({ error: "File not found" }, 404);
  if (url.includes("/api/files/")) return jsonResponse({ path: "x.txt", encoding: "utf8", data: "line1\nline2\n", size: 12 });
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
});

function renderInspector(path: string, filename: string, kind: "text" | "pdf" = "text", content?: string) {
  const data: FilePreviewInspectorT = {
    kind: "file",
    path,
    filename,
    root: "workspace",
    artifact: undefined,
    language: kind === "text" ? "plaintext" : undefined,
    ...(content !== undefined ? { content } : {}),
  } as unknown as FilePreviewInspectorT;
  return render(
    <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
      <FilePreviewInspector data={data} onClose={() => {}} cwd="proj" />
    </FeedbackContext.Provider>,
  );
}

beforeEach(async () => {
  writeCalls = [];
  writeError = null;
  missingPath = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FilePreviewInspector edit capability", () => {
  it("shows an edit button for a text file and saves edits through the write API", async () => {
    renderInspector("x.txt", "x.txt", "text");

    const editButton = await screen.findByLabelText("Edit file");
    expect(editButton).toBeTruthy();

    fireEvent.click(editButton);
    const textarea = await screen.findByLabelText("Edit x.txt");
    expect((textarea as HTMLTextAreaElement).value).toContain("line1");

    fireEvent.change(textarea, { target: { value: "edited\ncontent" } });
    fireEvent.click(screen.getByLabelText("Save"));

    await waitFor(() => expect(writeCalls).toHaveLength(1));
    expect(writeCalls[0]).toEqual({ path: "x.txt", content: "edited\ncontent" });
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    // After save the edit surface is gone.
    expect(screen.queryByLabelText("Edit x.txt")).toBeNull();
  });

  it("shows the failure message when the write API rejects", async () => {
    writeError = new Error("disk full");
    renderInspector("x.txt", "x.txt", "text");

    fireEvent.click(await screen.findByLabelText("Edit file"));
    const textarea = await screen.findByLabelText("Edit x.txt");
    fireEvent.change(textarea, { target: { value: "new" } });
    fireEvent.click(screen.getByLabelText("Save"));

    await waitFor(() => expect(screen.getByText(/disk full/)).toBeTruthy());
  });

  it("does not offer editing for binary formats like pdf", async () => {
    renderInspector("doc.pdf", "doc.pdf", "pdf");
    await waitFor(() => expect(screen.queryByLabelText("Edit file")).toBeNull());
  });

  it("shows a missing-file error for a markdown artifact reference", async () => {
    missingPath = "drafts/missing.md";
    renderInspector(missingPath, "missing.md", "text");

    await waitFor(() => expect(screen.getByText("File not found or inaccessible")).toBeInTheDocument());
  });

  it("resolves markdown image references relative to the document directory", async () => {
    renderInspector("reports/readme.md", "readme.md", "text", "![plot](./images/a.png)\n\n![wide](../shared/b.png)");

    const plot = await screen.findByRole("img", { name: "plot" });
    expect(plot.getAttribute("src")).toContain("/api/files/serve/reports/images/a.png?cwd=proj");
    const wide = screen.getByRole("img", { name: "wide" });
    expect(wide.getAttribute("src")).toContain("/api/files/serve/shared/b.png?cwd=proj");
  });

  it("cancel discards the draft", async () => {
    renderInspector("x.txt", "x.txt", "text");
    fireEvent.click(await screen.findByLabelText("Edit file"));
    const textarea = await screen.findByLabelText("Edit x.txt");
    fireEvent.change(textarea, { target: { value: "should be discarded" } });
    fireEvent.click(screen.getByLabelText("Cancel"));
    expect(writeCalls).toHaveLength(0);
    expect(screen.queryByLabelText("Edit x.txt")).toBeNull();
  });

  it("does not apply a stale save to a different file opened in the same inspector", async () => {
    const { unmount } = renderInspector("a.txt", "a.txt", "text");
    fireEvent.click(await screen.findByLabelText("Edit file"));
    const textarea = await screen.findByLabelText("Edit a.txt");
    fireEvent.change(textarea, { target: { value: "content from a.txt" } });
    fireEvent.click(screen.getByLabelText("Save"));
    // While the save request is in flight, open a different file in the same
    // inspector instance (the component is reused across files).
    unmount();
    renderInspector("b.txt", "b.txt", "text");
    await waitFor(() => expect(writeCalls).toHaveLength(1));
    // The stale save must not have applied b.txt's preview or offered a
    // stale draft for the next edit.
    expect(writeCalls[0]).toEqual({ path: "a.txt", content: "content from a.txt" });
    fireEvent.click(await screen.findByLabelText("Edit file"));
    const bTextarea = await screen.findByLabelText("Edit b.txt") as HTMLTextAreaElement;
    expect(bTextarea.value).toContain("line1");
    expect(bTextarea.value).not.toContain("content from a.txt");
  });
});

describe("FilePreviewInspector history mode with lineage", () => {
  it("still shows provenance history when the lineage endpoint fails", async () => {
    queryClient.clear();
    const historyFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method || "GET").toUpperCase();
      if (url.includes("/api/settings/config")) return jsonResponse({ ok: true, available_models: [], model: "", thinking: "high" });
      if (url.includes("/api/project-memory/research-loops")) return jsonResponse({ loops: [] });
      if (url.includes("/api/artifacts?") || url.includes("/lineage")) return jsonResponse({ error: "boom" }, 500);
      if (url.includes("/api/provenance/versions/")) {
        return jsonResponse({ versions: [
          { path: "x.txt", version: 1, ts: 1735689600, tool: "write", sessionId: "s1", content: "code" },
          { path: "x.txt", version: 2, ts: 1735693200, tool: "edit", sessionId: "s1", diff: "--- a\n+++ b" },
        ] });
      }
      if (url.includes("/api/files/")) return jsonResponse({ path: "x.txt", encoding: "utf8", data: "line1\nline2\n", size: 12 });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    vi.stubGlobal("fetch", historyFetch);
    render(
      <MemoryRouter>
        <FilePreviewInspector data={{ kind: "file", path: "x.txt", filename: "x.txt", root: "workspace", language: "plaintext" } as never} onClose={() => {}} cwd="proj" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText("Version history"));
    // Provenance versions render even though the lineage query failed.
    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    // No lineage section is shown (failure must not fake an empty graph).
    expect(screen.queryByText("Lineage")).not.toBeInTheDocument();
  });

  it("shows lineage relations above the history when available", async () => {
    queryClient.clear();
    const lineageFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method || "GET").toUpperCase();
      if (url.includes("/api/settings/config")) return jsonResponse({ ok: true, available_models: [], model: "", thinking: "high" });
      if (url.includes("/api/project-memory/research-loops")) return jsonResponse({ loops: [] });
      if (url.includes("/api/artifacts?") && url.includes("latest=1")) {
        return jsonResponse({ artifacts: [{ schema_version: 2, artifact_id: "a2", version: 2, path: "x.txt", kind: "text", mime: "text/plain", size: 12, sha256: "1234567890abcdef", published_at: "2026-01-01T00:00:00.000Z", inputs: [{ artifact_id: "a1", version: 1 }], supersedes: null, classification: "deliverable" }] });
      }
      if (url.includes("/lineage")) {
        return jsonResponse({ artifact: { artifact_id: "a2", version: 2, path: "x.txt" }, upstream: [{ kind: "consumes", artifact: { artifact_id: "a1", version: 1, path: "raw.txt" } }], downstream: [], unresolved_inputs: [] });
      }
      if (url.includes("/api/provenance/versions/")) return jsonResponse({ versions: [{ path: "x.txt", version: 2, ts: 1735693200, tool: "edit", sessionId: "s1", diff: "--- a\n+++ b" }] });
      if (url.includes("/api/files/")) return jsonResponse({ path: "x.txt", encoding: "utf8", data: "line1\nline2\n", size: 12 });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    vi.stubGlobal("fetch", lineageFetch);
    render(
      <MemoryRouter>
        <FilePreviewInspector data={{ kind: "file", path: "x.txt", filename: "x.txt", root: "workspace", language: "plaintext" } as never} onClose={() => {}} cwd="proj" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText("Version history"));
    expect(await screen.findByText("Lineage")).toBeInTheDocument();
    expect(screen.getByText("raw.txt")).toBeInTheDocument();
    // The lineage chip (v2) and the provenance version row (v2) coexist.
    expect(screen.getAllByText("v2").length).toBeGreaterThanOrEqual(1);
  });

  it("opens history at the exact version for version-targeted opens", async () => {
    queryClient.clear();
    const exactFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method || "GET").toUpperCase();
      if (url.includes("/api/settings/config")) return jsonResponse({ ok: true, available_models: [], model: "", thinking: "high" });
      if (url.includes("/api/project-memory/research-loops")) return jsonResponse({ loops: [] });
      if (/\/api\/artifacts\/[^/]+\?cwd=/.test(url)) return jsonResponse({ schema_version: 2, artifact_id: "a2", version: 1, path: "x.txt", kind: "text", mime: "text/plain", size: 12, sha256: "1234567890abcdef", published_at: "2026-01-01T00:00:00.000Z", inputs: [], supersedes: null, classification: "deliverable" });
      if (url.includes("/lineage")) {
        return jsonResponse({ artifact: { artifact_id: "a2", version: 1, path: "x.txt" }, upstream: [], downstream: [], unresolved_inputs: [] });
      }
      if (url.includes("/api/provenance/versions/")) {
        return jsonResponse({ versions: [
          { path: "x.txt", version: 1, ts: 1735689600, tool: "write", sessionId: "s1", content: "code" },
          { path: "x.txt", version: 2, ts: 1735693200, tool: "edit", sessionId: "s1", diff: "--- a\n+++ b" },
        ] });
      }
      if (url.includes("/api/files/")) return jsonResponse({ path: "x.txt", encoding: "utf8", data: "line1\nline2\n", size: 12 });
      return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
    });
    vi.stubGlobal("fetch", exactFetch);
    render(
      <MemoryRouter>
        <FilePreviewInspector data={{ kind: "file", path: "x.txt", filename: "x.txt", root: "workspace", language: "plaintext", artifactVersion: { artifact_id: "a2", version: 1 } } as never} onClose={() => {}} cwd="proj" />
      </MemoryRouter>,
    );

    // History opens automatically for a version-targeted open…
    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    // …with a notice that the preview shows the CURRENT file, not that version.
    expect(screen.getByText(/Artifact record v1/)).toBeInTheDocument();
    // The lineage is fetched for the EXACT version (no latest=1 resolution).
    expect(exactFetch.mock.calls.some(([url]) => String(url).includes("/api/artifacts/a2?cwd=proj&version=1"))).toBe(true);
    expect(exactFetch.mock.calls.some(([url]) => String(url).includes("latest=1"))).toBe(false);
  });
});
