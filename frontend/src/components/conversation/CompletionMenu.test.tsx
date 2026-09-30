import { useRef } from "react";
import type { RefObject } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import i18n from "@/i18n";
import type { CompletionItem } from "../../lib/conversation/completion";
import { CompletionMenu } from "./CompletionMenu";

const items: CompletionItem[] = [
  { id: "command:export", kind: "command", label: "/export", description: "Export the conversation", detail: "<html|jsonl>", insertText: "/export " },
  { id: "file:data/protein.csv", kind: "file", label: "protein.csv", description: "Sequence table", insertText: "data/protein.csv", size: 2048 },
  { id: "directory:results", kind: "directory", label: "results/", insertText: "results/", size: 512 },
];

function menu(props: Partial<{ items: CompletionItem[]; activeIndex: number; onSelect: (item: CompletionItem) => void; onActiveChange: (index: number) => void; onDismiss: () => void; inputRef: RefObject<HTMLTextAreaElement | null> }>) {
  return (
    <CompletionMenu
      id="completion"
      label="Completions"
      items={props.items ?? items}
      activeIndex={props.activeIndex ?? 0}
      onSelect={props.onSelect ?? vi.fn()}
      onActiveChange={props.onActiveChange ?? vi.fn()}
      onDismiss={props.onDismiss ?? vi.fn()}
      inputRef={props.inputRef}
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
  it("keeps the caption font size and the tinted label chip on every row, active included", () => {
    render(menu({ activeIndex: 1 }));
    const rows = screen.getAllByRole("option");
    for (const row of rows) expect(row).toHaveClass("text-ui-caption");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
    for (const row of rows) expect(row.querySelector("span")).toHaveClass("bg-accent-soft", "text-text");
  });

  it("renders no listbox for an empty candidate list", () => {
    render(menu({ items: [] }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("renders no key badge on a row", () => {
    render(menu({ activeIndex: 1 }));
    expect(document.querySelector("kbd")).toBeNull();
    expect(within(screen.getAllByRole("option")[1]).getByText("2.0 KB")).toBeInTheDocument();
  });

  it("orders a row as name, description, then the trailing markers", () => {
    render(menu({}));
    const texts = [...(document.getElementById("completion-option-0") as HTMLElement).querySelectorAll("span")].map((span) => span.textContent);
    expect(texts).toEqual(["/export", "Export the conversation", "<html|jsonl>"]);
  });

  it("renders each row's label, detail, description, and formatted size", () => {
    render(menu({}));
    expect(screen.getByText("/export")).toBeInTheDocument();
    expect(screen.getByText("<html|jsonl>")).toBeInTheDocument();
    expect(screen.getByText("Export the conversation")).toBeInTheDocument();
    expect(screen.getByText("protein.csv")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("shows the formatted size on a file row and no size on a directory row", () => {
    render(menu({}));
    const rows = screen.getAllByRole("option");
    expect(within(rows[1]).getByText("2.0 KB")).toBeInTheDocument();
    expect(within(rows[2]).queryByText("512 B")).not.toBeInTheDocument();
  });

  it("marks a reference row and leaves an agent row unmarked", () => {
    render(menu({
      items: [
        { id: "mention:path:data/protein.csv", kind: "file", label: "protein.csv", group: "files", insertText: "", size: 2048, payload: { kind: "reference", reference: { path: "data/protein.csv", name: "protein.csv", isDir: false } } },
        { id: "mention:agent:reviewer", kind: "subagent", label: "@reviewer", group: "agents", insertText: "@reviewer ", payload: { kind: "mention", name: "reviewer", token: "@reviewer" } },
      ],
    }));
    expect(screen.getAllByText("Reference")).toHaveLength(1);
    expect(within(document.getElementById("completion-option-0") as HTMLElement).getByText("Reference")).toBeInTheDocument();
    expect(within(document.getElementById("completion-option-1") as HTMLElement).queryByText("Reference")).not.toBeInTheDocument();
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

  it("reports the hovered row and selects it once activeIndex moves there", () => {
    const onActiveChange = vi.fn();
    const { rerender } = render(menu({ onActiveChange }));
    fireEvent.mouseEnter(document.getElementById("completion-option-2") as HTMLElement);
    expect(onActiveChange).toHaveBeenCalledWith(2);
    expect(onActiveChange).toHaveBeenCalledTimes(1);

    rerender(menu({ activeIndex: 2, onActiveChange }));
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

  it("dismisses on an outside pointerdown, not on one inside the menu or the input", () => {
    const onDismiss = vi.fn();
    function Case() {
      const inputRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={inputRef} data-testid="composer" />
          {menu({ onDismiss, inputRef })}
        </>
      );
    }
    render(<Case />);

    fireEvent.pointerDown(document.getElementById("completion-option-0") as HTMLElement);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByTestId("composer"));
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
