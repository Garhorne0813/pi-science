import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { ResearchTab } from "./ResearchTab";
import { useUiStore } from "../../lib/ui";
const { newConversation, exportArchive } = vi.hoisted(() => ({ newConversation: vi.fn(), exportArchive: vi.fn(async () => ({ archive: { path: "research/archives/legacy/history.json" } })) }));
vi.mock("../sidebar/workspace-navigation", () => ({ useNewWorkspaceConversation: () => newConversation }));
vi.mock("../../lib/knowledge", () => ({ projectMemoryApi: { exportArchive }, useMemoryArchives: () => ({ data: { archives: [{ id: "legacy", title: "Historical optimization", objective: "Improve accuracy", status: "running", path: "research/archives/legacy/history.json", record_count: 3 }] }, error: null }) }));
beforeEach(() => { newConversation.mockClear(); exportArchive.mockClear(); });
beforeAll(async () => { await i18n.changeLanguage("en"); });
it("opens saved archive files and offers conversation continuation without legacy execution controls", async () => {
  const openInspector = vi.fn(); useUiStore.setState({ openInspector });
  render(<ResearchTab cwd="project" onError={vi.fn()} />);
  expect(exportArchive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "research/archives/legacy/history.json" })); await waitFor(() => expect(openInspector).toHaveBeenCalledWith(expect.objectContaining({ path: "research/archives/legacy/history.json" })));
  fireEvent.click(screen.getByRole("button", { name: /Historical optimization/ })); await waitFor(() => expect(newConversation).toHaveBeenCalledWith({ draft: expect.stringContaining("/skill:auto-research Resume from the historical archive research/archives/legacy/history.json") }));
  expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
});

it("reports an explicit export failure without opening a missing file or starting continuation", async () => {
  const openInspector = vi.fn(); const onError = vi.fn(); useUiStore.setState({ openInspector });
  exportArchive.mockRejectedValueOnce(new Error("Export failed"));
  render(<ResearchTab cwd="project" onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: /Historical optimization/ }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Export failed"));
  expect(newConversation).not.toHaveBeenCalled(); expect(openInspector).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /Historical optimization/ })).not.toBeDisabled();
});
