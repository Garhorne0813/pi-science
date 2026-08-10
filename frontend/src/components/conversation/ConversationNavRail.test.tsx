import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationNavRail, type ConversationNavItem } from "./ConversationNavRail";
import i18n from "../../i18n";

/** Captures its callback and root so tests can drive the highlight logic manually. */
class IOStub {
  static instances: IOStub[] = [];
  cb: IntersectionObserverCallback;
  root: Element | null;
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.cb = cb;
    this.root = (options?.root instanceof Element ? options.root : null);
    IOStub.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const ITEMS: ConversationNavItem[] = [
  { id: "u1", label: "First question about models" },
  { id: "u2", label: "Second question about data" },
];

function renderRail(items: ConversationNavItem[] = ITEMS) {
  const root = document.createElement("div");
  for (const item of items) {
    const el = document.createElement("div");
    el.id = `user-msg-${item.id}`;
    root.appendChild(el);
  }
  // Give the root real geometry so the near-bottom fallback does not swallow
  // the ratio-based highlight branch in every test.
  Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
  const onSelect = vi.fn();
  render(<ConversationNavRail items={items} rootRef={{ current: root }} onSelect={onSelect} />);
  return { onSelect };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  IOStub.instances = [];
  vi.stubGlobal("IntersectionObserver", IOStub);
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConversationNavRail", () => {
  it("renders one entry per item with the summary label", () => {
    renderRail();
    const navigation = screen.getByRole("navigation", { name: "Conversation" });
    expect(navigation).toBeInTheDocument();
    expect(navigation).toHaveStyle({ maxHeight: "min(55vh, 520px)" });
    expect(screen.getByRole("button", { name: "First question about models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second question about data" })).toBeInTheDocument();
  });

  it("shows only the hovered message preview and removes it on mouse leave", () => {
    renderRail();
    const first = screen.getByRole("button", { name: "First question about models" });

    fireEvent.mouseMove(first);
    expect(screen.getByRole("tooltip")).toHaveTextContent("First question about models");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Second question about data");

    fireEvent.mouseLeave(screen.getByRole("navigation", { name: "Conversation" }).parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("activates the nearest row from movement anywhere in the transparent rail hit area", () => {
    renderRail([
      { id: "u1", label: "One" },
      { id: "u2", label: "Two" },
      { id: "u3", label: "Three" },
    ]);
    const navigation = screen.getByRole("navigation", { name: "Conversation" });
    vi.spyOn(navigation, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 100, top: 100, left: 0, right: 80, bottom: 148, width: 80, height: 48, toJSON: () => ({}),
    });

    // Target the nav container itself—not a button or the visible 8px stroke.
    fireEvent.pointerMove(navigation, { clientY: 124 });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Two");
    expect(screen.getByRole("button", { name: "Two" }).querySelector<HTMLElement>("[data-nav-indicator]")).toHaveStyle({ width: "48px" });
  });

  it("renders nothing for an empty item list", () => {
    renderRail([]);
    expect(screen.queryByRole("navigation", { name: "Conversation" })).toBeNull();
  });

  it("calls onSelect with the item id on click", () => {
    const { onSelect } = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Second question about data" }));
    expect(onSelect).toHaveBeenCalledWith("u2");
  });

  it("highlights the clicked entry immediately, without waiting for the observer", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Second question about data" }));
    // No observer callback was fired — the highlight must come from the click.
    const button = screen.getByRole("button", { name: "Second question about data" });
    expect(button).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "First question about models" })).not.toHaveAttribute("aria-current");
  });

  it("keeps every line short at rest and moves the length gradient with hover", () => {
    renderRail([
      { id: "u1", label: "One" },
      { id: "u2", label: "Two" },
      { id: "u3", label: "Three" },
      { id: "u4", label: "Four" },
      { id: "u5", label: "Five" },
    ]);

    const width = (name: string) => screen.getByRole("button", { name }).querySelector<HTMLElement>("[data-nav-indicator]")?.style.width;
    expect(["One", "Two", "Three", "Four", "Five"].map(width)).toEqual(["8px", "8px", "8px", "8px", "8px"]);

    fireEvent.mouseMove(screen.getByRole("button", { name: "Three" }));
    expect(width("Three")).toBe("48px");
    expect(width("Two")).toBe("36px");
    expect(width("Four")).toBe("36px");
    expect(width("One")).toBe("24px");
    expect(width("Five")).toBe("24px");

    fireEvent.mouseMove(screen.getByRole("button", { name: "Five" }));
    expect(width("Five")).toBe("48px");
    expect(width("Four")).toBe("36px");
    expect(width("Three")).toBe("24px");
    expect(width("One")).toBe("8px");

    fireEvent.mouseLeave(screen.getByRole("navigation", { name: "Conversation" }).parentElement!);
    expect(["One", "Two", "Three", "Four", "Five"].map(width)).toEqual(["8px", "8px", "8px", "8px", "8px"]);
  });

  it("compresses long conversations inside the bounded scroll rail", () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ id: `u${index}`, label: `Question ${index}` }));
    renderRail(items);

    const navigation = screen.getByRole("navigation", { name: "Conversation" });
    expect(navigation).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("button", { name: "Question 0" })).toHaveStyle({ height: "12px" });
    expect(screen.getByRole("button", { name: "Question 44" })).toBeInTheDocument();
  });

  it("highlights the intersecting entry from the observer callback", () => {
    renderRail();
    const io = IOStub.instances[IOStub.instances.length - 1];
    const target1 = document.createElement("div");
    target1.id = "user-msg-u1";
    const target2 = document.createElement("div");
    target2.id = "user-msg-u2";
    act(() => {
      io.cb([
        { target: target2, isIntersecting: true, intersectionRatio: 0.8 } as unknown as IntersectionObserverEntry,
        { target: target1, isIntersecting: false, intersectionRatio: 0 } as unknown as IntersectionObserverEntry,
      ], io as unknown as IntersectionObserver);
    });
    expect(screen.getByRole("button", { name: "Second question about data" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "First question about models" })).not.toHaveAttribute("aria-current");
  });

  it("falls back to the last entry when scrolled to the bottom", () => {
    renderRail();
    const io = IOStub.instances[IOStub.instances.length - 1];
    const target = document.createElement("div");
    target.id = "user-msg-u1";
    // scrollTop = 1940 -> 2000 - 1940 - 600 < 96: the near-bottom branch wins.
    const root = io.root;
    if (!root) throw new Error("IO root not captured");
    Object.defineProperty(root, "scrollTop", { value: 1940, configurable: true });
    act(() => {
      io.cb([{ target, isIntersecting: false, intersectionRatio: 0 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(screen.getByRole("button", { name: "Second question about data" })).toHaveAttribute("aria-current", "true");
  });
});
