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
    expect(screen.getByRole("navigation", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First question about models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second question about data" })).toBeInTheDocument();
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
