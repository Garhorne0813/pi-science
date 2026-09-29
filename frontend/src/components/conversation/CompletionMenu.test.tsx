import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { CompletionItem } from "../../lib/conversation/completion";
import { CompletionMenu } from "./CompletionMenu";

const items: CompletionItem[] = [
  { id: "command:export", kind: "command", label: "/export", description: "Export the conversation", detail: "<html|jsonl>", insertText: "/export " },
  { id: "file:data/protein.csv", kind: "file", label: "protein.csv", description: "Sequence table", insertText: "data/protein.csv", size: 2048 },
  { id: "directory:results", kind: "directory", label: "results/", insertText: "results/", size: 512 },
];

function menu(props: Partial<{ items: CompletionItem[]; activeIndex: number; onSelect: (item: CompletionItem) => void; onDismiss: () => void }>) {
  return (
    <CompletionMenu
      id="completion"
      label="Completions"
      items={props.items ?? items}
      activeIndex={props.activeIndex ?? 0}
      onSelect={props.onSelect ?? vi.fn()}
      onDismiss={props.onDismiss ?? vi.fn()}
    />
  );
}

function stubScrollIntoView() {
  const original = HTMLElement.prototype.scrollIntoView;
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  return {
    scrollIntoView,
    restore: () => {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: original });
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    },
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("CompletionMenu", () => {
  it("renders no listbox for an empty candidate list", () => {
    render(menu({ items: [] }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("renders each row's label, detail, description, and formatted size", () => {
    render(menu({}));
    expect(screen.getByText("/export")).toBeInTheDocument();
    expect(screen.getByText("<html|jsonl>")).toBeInTheDocument();
    expect(screen.getByText("Export the conversation")).toBeInTheDocument();
    expect(screen.getByText("protein.csv")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();
  });

  it("shows a folder icon for directories, a file icon for files, and none otherwise", () => {
    render(menu({}));
    expect(document.querySelector("#completion-option-0 svg")).toBeNull();
    expect(document.querySelector("#completion-option-1 svg.lucide-file")).toBeInTheDocument();
    expect(document.querySelector("#completion-option-2 svg.lucide-folder-open")).toBeInTheDocument();
  });

  it("marks only the active row selected and follows activeIndex", () => {
    const { rerender } = render(menu({ activeIndex: 1, onSelect: vi.fn(), onDismiss: vi.fn() }));
    expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);

    rerender(menu({ activeIndex: 2, onSelect: vi.fn(), onDismiss: vi.fn() }));
    expect(screen.getAllByRole("option").map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
  });

  it("selects the clicked row with that exact item and prevents the default mousedown", () => {
    const onSelect = vi.fn();
    render(
      <>
        <textarea data-testid="composer" />
        {menu({ onSelect })}
      </>,
    );
    const textarea = screen.getByTestId("composer");
    textarea.focus();

    const row = document.getElementById("completion-option-1") as HTMLElement;
    expect(fireEvent.mouseDown(row)).toBe(false);
    expect(document.activeElement).toBe(textarea);

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe(items[1]);
  });

  it("dismisses on an outside pointerdown and stays open on an inside one", () => {
    const onDismiss = vi.fn();
    render(menu({ onDismiss }));

    fireEvent.pointerDown(document.getElementById("completion-option-0") as HTMLElement);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("scrolls the active row into view when activeIndex changes", () => {
    const { scrollIntoView, restore } = stubScrollIntoView();
    try {
      const { rerender } = render(menu({ activeIndex: 0, onSelect: vi.fn(), onDismiss: vi.fn() }));
      scrollIntoView.mockClear();

      rerender(menu({ activeIndex: 1, onSelect: vi.fn(), onDismiss: vi.fn() }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect((scrollIntoView.mock.instances.at(-1) as HTMLElement).id).toBe("completion-option-1");
    } finally {
      restore();
    }
  });

  it("does not scroll while activeIndex stays the same", () => {
    const { scrollIntoView, restore } = stubScrollIntoView();
    try {
      const onSelect = vi.fn();
      const onDismiss = vi.fn();
      const { rerender } = render(menu({ activeIndex: 1, onSelect, onDismiss }));
      scrollIntoView.mockClear();

      rerender(menu({ activeIndex: 1, onSelect, onDismiss }));
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("groups rows under translated headings when more than one group is present", () => {
    const agents = i18n.t("conversation.completion.groupAgents");
    const files = i18n.t("conversation.completion.groupFiles");
    render(menu({
      items: [
        { id: "subagent:scout", kind: "subagent", label: "scout", group: "agents", insertText: "@scout " },
        { ...items[1], group: "files" },
        { ...items[2], group: "files" },
      ],
    }));

    expect(screen.getByRole("group", { name: agents })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: files })).toBeInTheDocument();
    expect(screen.getByText(agents)).toBeInTheDocument();
    expect(screen.getByText(files)).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("renders a single-group list flat, with no wrapper or heading", () => {
    render(menu({ items: items.map((item) => ({ ...item, group: "agents" })) }));

    expect(screen.getAllByRole("option")).toHaveLength(items.length);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("conversation.completion.groupAgents"))).not.toBeInTheDocument();
  });

  it("renders a group-free list flat", () => {
    render(menu({}));
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(items.length);
  });
});
