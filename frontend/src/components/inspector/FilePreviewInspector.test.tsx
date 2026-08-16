/** Characterization tests for the inspector's new file-edit capability:
 *  an edit button appears for editable text files, the save path calls the
 *  write API, and binary files never offer editing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
let truncatedPath: string | null = null;
let fullMarkdownLoaded = false;

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
  if (truncatedPath && url.includes(`/api/files/${truncatedPath}`)) {
    return fullMarkdownLoaded
      ? jsonResponse({ path: truncatedPath, encoding: "utf8", data: "# Full file\n\nComplete content", size: 29 })
      : jsonResponse({ path: truncatedPath, encoding: "utf8", data: "# Partial preview", size: 2 * 1024 * 1024, truncated: true });
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
  truncatedPath = null;
  fullMarkdownLoaded = false;
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

  it("caps large markdown previews and loads the full file on demand", async () => {
    truncatedPath = "large.md";
    renderInspector(truncatedPath, truncatedPath, "text");

    expect(await screen.findByText("Only the first 2 MB are shown to keep the preview responsive.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Edit file")).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("maxBytes=2097152"))).toBe(true);

    fullMarkdownLoaded = true;
    fireEvent.click(screen.getByRole("button", { name: "Load full file" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Full file" })).toBeInTheDocument());
    expect(screen.getByLabelText("Edit file")).toBeInTheDocument();
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
