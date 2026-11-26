import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { FileContextMenu, type FileListEntry } from "./FileContextMenu";

const file: FileListEntry = { path: "reports/q1.csv", name: "q1.csv", isDir: false, size: 10, modified: 1 };
const folder: FileListEntry = { path: "reports", name: "reports", isDir: true, size: 0, modified: 1 };

function renderMenu(entry: FileListEntry, onDownload?: () => void) {
  render(
    <FileContextMenu
      entry={entry}
      point={{ x: 10, y: 20 }}
      onClose={() => undefined}
      onReference={() => undefined}
      onCopy={() => undefined}
      onReveal={() => undefined}
      onDownload={onDownload}
      onDelete={() => undefined}
    />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("FileContextMenu download item", () => {
  it("offers Download on a file between Copy name and Reveal in file manager", () => {
    renderMenu(file, vi.fn());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Reference file",
      "Copy path",
      "Copy name",
      "Download",
      "Reveal in file manager",
      "Delete",
    ]);
  });

  it("calls onDownload when the item is clicked", () => {
    const onDownload = vi.fn();
    renderMenu(file, onDownload);
    fireEvent.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("hides Download for folders", () => {
    renderMenu(folder, vi.fn());
    expect(screen.queryByRole("menuitem", { name: "Download" })).toBeNull();
  });

  it("hides Download when the caller offers no handler", () => {
    renderMenu(file);
    expect(screen.queryByRole("menuitem", { name: "Download" })).toBeNull();
  });
});
