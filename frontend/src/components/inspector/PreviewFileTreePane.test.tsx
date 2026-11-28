import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { useUiStore } from "@/lib/ui";
import { PreviewFileTreePane } from "./PreviewFileTreePane";

vi.mock("../sidebar/FileBrowser", () => ({ FileBrowser: () => <div>Tree contents</div> }));
vi.mock("./PreviewPaneControls", () => ({ PreviewPaneControls: () => <div>Preview controls</div> }));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  useUiStore.setState({ previewFileTreeSide: "left", previewFileTreeWidth: 232 });
});

describe("PreviewFileTreePane", () => {
  it("moves the split tree and its resize handle to the selected side", () => {
    render(<PreviewFileTreePane cwd="project" conversationKey="session" split />);

    const tree = screen.getByRole("region", { name: "Workspace file tree" });
    const divider = screen.getByRole("separator", { name: "Resize file browser" });
    expect(tree).toHaveClass("left-0", "border-r");
    expect(divider).toHaveClass("right-0");

    act(() => useUiStore.getState().setPreviewFileTreeSide("right"));

    expect(tree).toHaveClass("right-0", "border-l", "lg:order-2");
    expect(divider).toHaveClass("left-0");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(useUiStore.getState().previewFileTreeWidth).toBe(248);
  });
});
