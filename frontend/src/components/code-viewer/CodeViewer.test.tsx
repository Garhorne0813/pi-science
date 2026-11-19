import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import hljs from "highlight.js/lib/common";
import { CodeViewer } from "./CodeViewer";
import i18n, { i18nReady } from "../../i18n";

await i18nReady;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function codeText(container: HTMLElement): string | null | undefined {
  return container.querySelector("code")?.textContent;
}

describe("CodeViewer highlighting policy", () => {
  it("never auto-detects a declared language that the common bundle does not have", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container } = render(<CodeViewer code={"<tag> & raw"} language="julia" />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe("<tag> & raw");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders plaintext without calling into highlight.js", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container } = render(<CodeViewer code={"ATOM      1  N   ALA A   1"} language="plaintext" />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe("ATOM      1  N   ALA A   1");
  });

  it("uses the declared grammar when it exists", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    render(<CodeViewer code={'{"a":1}'} language="json" />);

    expect(highlight).toHaveBeenCalledWith('{"a":1}', { language: "json" });
  });

  it("still auto-detects small text files with no declared language", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    render(<CodeViewer code={"plain text"} />);

    expect(auto).toHaveBeenCalledTimes(1);
  });

  it("still auto-detects text exactly at the auto-detection cap", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const lines = Array.from({ length: 400 }, (_, i) => `2026-11-19T13:00:00Z INFO row ${i} value=${i * 7}`);
    // Fixed size, independent of the constant: lowering the cap must make this fail.
    const code = lines.join("\n").slice(0, 20_000).padEnd(20_000, " ");
    render(<CodeViewer code={code} />);

    expect(code).toHaveLength(20_000);
    expect(auto).toHaveBeenCalledTimes(1);
  });

  it("skips auto-detection above the cap and says so", () => {
    const auto = vi.spyOn(hljs, "highlightAuto");
    const highlight = vi.spyOn(hljs, "highlight");
    // Fixed size, independent of the constant: raising the cap must make this fail.
    const code = Array.from({ length: 400 }, (_, i) => `2026-11-19T13:00:00Z INFO row ${i} value=${i * 7}`)
      .join("\n")
      .slice(0, 20_001)
      .padEnd(20_001, "y");
    const { container } = render(<CodeViewer code={code} />);

    expect(auto).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe(code);
    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("filePreview.highlightSkippedNoLanguage"));
  });

  it("keeps highlighting an explicit grammar above the auto-detection cap", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    render(<CodeViewer code={"x".repeat(20_001)} language="json" />);

    expect(highlight).toHaveBeenCalledTimes(1);
  });

  it("highlights exactly at the one-million-character guard", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    const code = "a".repeat(1_000_000);
    render(<CodeViewer code={code} language="python" />);

    expect(highlight).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("skips highlighting above the size guard and says so", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    // Fixed size, independent of the constant: raising the guard must make this fail.
    const code = "a".repeat(1_000_001);
    const { container } = render(<CodeViewer code={code} language="python" />);

    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe(code);
    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("filePreview.highlightSkipped"));
  });

  it("highlights exactly at the line guard", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    const code = Array.from({ length: 20_000 }, () => "x").join("\n");
    render(<CodeViewer code={code} language="python" />);

    expect(highlight).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("skips highlighting above the line guard and says so", () => {
    const highlight = vi.spyOn(hljs, "highlight");
    const code = Array.from({ length: 20_001 }, () => "x").join("\n");
    const { container } = render(<CodeViewer code={code} language="python" />);

    expect(highlight).not.toHaveBeenCalled();
    expect(codeText(container)).toBe(code);
    expect(screen.getByRole("status")).toHaveTextContent(i18n.t("filePreview.highlightSkipped"));
  });
});
