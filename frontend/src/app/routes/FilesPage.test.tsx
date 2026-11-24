import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { FilesPage } from "./FilesPage";

vi.mock("../../lib/workspace", () => ({
  useRequiredWorkspaceCwd: () => "proj",
}));

vi.mock("../../components/sidebar/FileBrowser", () => ({
  FileBrowser: ({ cwd, embedded, mode, fileType }: { cwd: string; embedded?: boolean; mode?: string; fileType?: string }) => (
    <div data-testid="file-browser" data-cwd={cwd} data-embedded={String(embedded)} data-mode={mode} data-file-type={fileType} />
  ),
}));

vi.mock("../../components/layout/WorkspacePage", () => ({
  WorkspacePage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  WorkspacePageHeader: ({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) => (
    <header><h1>{title}</h1><p>{description}</p></header>
  ),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("FilesPage", () => {
  it("renders the shared file tree in full page mode", () => {
    render(<FilesPage />);

    expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByText("Browse the workspace and preview a file without losing the tree.")).toBeInTheDocument();
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-cwd", "proj");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-embedded", "true");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-mode", "page");
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-file-type", "all");
  });

  it("preserves the notebook-only route", () => {
    window.history.pushState({}, "", "/workspace/proj/files?type=notebook");
    render(<FilesPage />);
    expect(screen.getByTestId("file-browser")).toHaveAttribute("data-file-type", "notebook");
    window.history.pushState({}, "", "/");
  });
});
