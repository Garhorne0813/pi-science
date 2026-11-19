/** Pins the language passed to the code view for preview kinds that have no
 *  highlight.js grammar (molecule / genome). The real CodeViewer is replaced
 *  with a probe so the assertion is about the inspector's policy, not styling. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeedbackContext } from "../feedback/feedback-context";
import type { FilePreviewInspector as FilePreviewInspectorT } from "../../types/thread";
import i18n, { i18nReady } from "../../i18n";

vi.mock("@/components/code-viewer/CodeViewer", () => ({
  CodeViewer: ({ language }: { language?: string }) => (
    <div data-testid="code-viewer" data-language={language ?? "undefined"} />
  ),
}));

import { FilePreviewInspector } from "./FilePreviewInspector";

await i18nReady;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/settings/config")) return jsonResponse({ ok: true, available_models: [], model: "", thinking: "high" });
    if (url.includes("/api/files/")) {
      return jsonResponse({ path: "structure.pdb", encoding: "utf8", data: "ATOM      1  N   ALA A   1\nEND", size: 35 });
    }
    return jsonResponse({ error: `unhandled ${url}` }, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderFile(filename: string) {
  const data = {
    kind: "file",
    path: filename,
    filename,
    root: "workspace",
    artifact: undefined,
    language: undefined,
  } as unknown as FilePreviewInspectorT;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <FilePreviewInspector data={data} onClose={() => {}} cwd="proj" />
      </FeedbackContext.Provider>
    </QueryClientProvider>,
  );
}

describe("markup-free previews render their code tab as plaintext", () => {
  it.each(["structure.pdb", "variants.vcf"])("%s", async (filename) => {
    renderFile(filename);
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("filePreview.tabs.code") }));
    expect(await screen.findByTestId("code-viewer")).toHaveAttribute("data-language", "plaintext");
  });
});
