import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SheetHtml } from "../../lib/shared/xlsx";
import i18n, { i18nReady } from "../../i18n";

const { workbookSheets } = vi.hoisted(() => ({ workbookSheets: vi.fn() }));

vi.mock("@/lib/shared/xlsx", () => ({ workbookSheets }));

import { XlsxView } from "./OfficePreview";

await i18nReady;

function sheet(
  name: string,
  rows: number,
  options: { columns?: number; truncatedRows?: boolean; truncatedColumns?: boolean; html?: string } = {},
): SheetHtml {
  return {
    name,
    rows,
    columns: options.columns ?? 1,
    truncatedRows: options.truncatedRows ?? false,
    truncatedColumns: options.truncatedColumns ?? false,
    html: options.html ?? `<table><tbody><tr><td>${name}</td></tr></tbody></table>`,
  };
}

/** The workbook HTML is written into a shadow root, so query it through the host. */
function shadowPage(container: HTMLElement): string {
  const host = [...container.querySelectorAll("div")].find((node) => node.shadowRoot);
  return host?.shadowRoot?.querySelector(".page")?.innerHTML ?? "";
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  workbookSheets.mockReset();
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("XlsxView", () => {
  it("shows the rendered row count in the row-truncation notice instead of a bare placeholder", async () => {
    workbookSheets.mockResolvedValue([sheet("Data", 600, { truncatedRows: true })]);
    render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="truncation" />);

    const notice = await screen.findByText(/Showing the first 600 rows/);
    expect(notice.textContent).not.toContain("{{count}}");

    await act(() => i18n.changeLanguage("zh-Hans"));
    const chinese = await screen.findByText(/显示前 600 行/);
    expect(chinese.textContent).not.toContain("{{count}}");
    expect(document.body.textContent).not.toContain("{{count}}");
  });

  it("names the column dimension when only the columns are truncated", async () => {
    // 3 × 81: the rows all fit; saying "Showing first 3 rows" would mislead.
    workbookSheets.mockResolvedValue([sheet("Wide", 3, { columns: 80, truncatedColumns: true })]);
    render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="columns" />);

    const notice = await screen.findByText(/Showing first 80 columns/);
    expect(notice.textContent).not.toContain("rows");

    await act(() => i18n.changeLanguage("zh-Hans"));
    expect(await screen.findByText(/显示前 80 列/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("行");
  });

  it("names both dimensions when rows and columns are both clamped", async () => {
    workbookSheets.mockResolvedValue([sheet("Huge", 600, { columns: 80, truncatedRows: true, truncatedColumns: true })]);
    render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="both" />);

    expect(await screen.findByText(/Showing first 600 rows × 80 columns/)).toBeInTheDocument();

    await act(() => i18n.changeLanguage("zh-Hans"));
    expect(await screen.findByText(/显示前 600 行 × 80 列/)).toBeInTheDocument();
  });

  it("shows no truncation notice when the sheet fits both limits", async () => {
    workbookSheets.mockResolvedValue([sheet("Small", 2, { columns: 80 })]);
    render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="fits" />);

    await screen.findByText(/Embedded charts are not shown in preview/);
    expect(document.body.textContent).not.toMatch(/Showing the first/);
  });

  it("keeps the selected sheet when a language change re-parses the workbook", async () => {
    workbookSheets.mockImplementation(async (_bytes: ArrayBuffer, locale?: string) => [
      sheet("First", 1, { html: `<table><tbody><tr><td>first-${locale}</td></tr></tbody></table>` }),
      sheet("Second", 1, { html: `<table><tbody><tr><td>second-${locale}</td></tr></tbody></table>` }),
    ]);
    const { container } = render(<XlsxView bytes={new ArrayBuffer(4)} scrollKey="tabs" />);

    fireEvent.click(await screen.findByRole("button", { name: "Second" }));
    await waitFor(() => expect(shadowPage(container)).toContain("second-en"));

    await act(() => i18n.changeLanguage("zh-Hans"));
    await waitFor(() => expect(shadowPage(container)).toContain("second-zh-Hans"));
  });

  it("returns to the first sheet when a new document uses the same tab names", async () => {
    // The name-based restore must not leak across documents: byte changes clear
    // the remembered name before the parse effect captures it.
    workbookSheets.mockImplementation(async (bytes: ArrayBuffer) => {
      const tag = new TextDecoder().decode(new Uint8Array(bytes));
      return [
        sheet("Data", 1, { html: `<table><tbody><tr><td>${tag}-first</td></tr></tbody></table>` }),
        sheet("Second", 1, { html: `<table><tbody><tr><td>${tag}-second</td></tr></tbody></table>` }),
      ];
    });
    const firstBytes = new TextEncoder().encode("alpha").buffer;
    const nextBytes = new TextEncoder().encode("beta").buffer;
    const { container, rerender } = render(<XlsxView bytes={firstBytes} scrollKey="doc" />);

    fireEvent.click(await screen.findByRole("button", { name: "Second" }));
    await waitFor(() => expect(shadowPage(container)).toContain("alpha-second"));

    rerender(<XlsxView bytes={nextBytes} scrollKey="doc-next" />);
    await waitFor(() => expect(shadowPage(container)).toContain("beta-first"));
    expect(shadowPage(container)).not.toContain("beta-second");
  });
});
