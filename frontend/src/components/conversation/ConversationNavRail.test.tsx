import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationNavRail, type ConversationNavItem } from "./ConversationNavRail";
import i18n from "../../i18n";

/** Captures its callback and root so tests can drive the highlight logic manually. */
class IOStub {
  static instances: IOStub[] = [];
  cb: IntersectionObserverCallback;
  root: Element | null;
  targets: Element[] = [];
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.cb = cb;
    this.root = (options?.root instanceof Element ? options.root : null);
    IOStub.instances.push(this);
  }
  observe(target: Element) {
    // Real IntersectionObservers ignore re-observing an already-observed
    // target; mirror that so the settle re-registration stays idempotent.
    if (!this.targets.includes(target)) this.targets.push(target);
  }
  unobserve() {}
  disconnect() {}
}

/** Captures its callback so tests can simulate added user-message nodes. */
class MOStub {
  static instances: MOStub[] = [];
  cb: MutationCallback;
  constructor(cb: MutationCallback) {
    this.cb = cb;
    MOStub.instances.push(this);
  }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

const ITEMS: ConversationNavItem[] = [
  { id: "u1", label: "First question about models" },
  { id: "u2", label: "Second question about data" },
];

function renderRail(items: ConversationNavItem[] = ITEMS, options: { bookmarkedIds?: ReadonlySet<string>; onActiveChange?: (id: string | null) => void } = {}) {
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
  render(<ConversationNavRail items={items} rootRef={{ current: root }} onSelect={onSelect} onActiveChange={options.onActiveChange} bookmarkedIds={options.bookmarkedIds} />);
  return { onSelect };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  IOStub.instances = [];
  MOStub.instances = [];
  vi.stubGlobal("IntersectionObserver", IOStub);
  vi.stubGlobal("MutationObserver", MOStub);
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
    expect(screen.getByRole("button", { name: "Two" }).querySelector<HTMLElement>("[data-nav-indicator]")).toHaveStyle({ width: "32px" });
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
    expect(width("Three")).toBe("32px");
    expect(width("Two")).toBe("24px");
    expect(width("Four")).toBe("24px");
    expect(width("One")).toBe("16px");
    expect(width("Five")).toBe("16px");

    fireEvent.mouseMove(screen.getByRole("button", { name: "Five" }));
    expect(width("Five")).toBe("32px");
    expect(width("Four")).toBe("24px");
    expect(width("Three")).toBe("16px");
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

  it("renders no aria-current until the observer establishes the active entry", () => {
    renderRail();
    // Before the IntersectionObserver reports geometry, no entry is active:
    // the rail must not default the highlight to the newest message.
    expect(screen.getByRole("button", { name: "First question about models" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Second question about data" })).not.toHaveAttribute("aria-current");
  });

  it("clears the highlight when the active message stops intersecting", () => {
    const onActiveChange = vi.fn();
    renderRail(ITEMS, { onActiveChange });
    const io = IOStub.instances[IOStub.instances.length - 1];
    const target2 = document.createElement("div");
    target2.id = "user-msg-u2";
    act(() => {
      io.cb([{ target: target2, isIntersecting: true, intersectionRatio: 0.8 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(screen.getByRole("button", { name: "Second question about data" })).toHaveAttribute("aria-current", "true");

    // The active message leaves the viewport band (or unmounts): the observer
    // reports it non-intersecting and the rail must drop the highlight instead
    // of keeping a stale active entry.
    act(() => {
      io.cb([{ target: target2, isIntersecting: false, intersectionRatio: 0 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(screen.getByRole("button", { name: "First question about models" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Second question about data" })).not.toHaveAttribute("aria-current");
    expect(onActiveChange).toHaveBeenLastCalledWith(null);
  });

  it("clears the highlight when the active item leaves the item list", () => {
    const root = document.createElement("div");
    for (const item of ITEMS) {
      const el = document.createElement("div");
      el.id = `user-msg-${item.id}`;
      root.appendChild(el);
    }
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
    const view = render(<ConversationNavRail items={ITEMS} rootRef={{ current: root }} onSelect={vi.fn()} />);
    const io = IOStub.instances[IOStub.instances.length - 1];
    const target2 = document.createElement("div");
    target2.id = "user-msg-u2";
    act(() => {
      io.cb([{ target: target2, isIntersecting: true, intersectionRatio: 0.8 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(screen.getByRole("button", { name: "Second question about data" })).toHaveAttribute("aria-current", "true");

    // u2 leaves the nav list (compaction/rewrite): the highlight must clear
    // rather than fall back to the last remaining entry.
    view.rerender(<ConversationNavRail items={[ITEMS[0]]} rootRef={{ current: root }} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "First question about models" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: "Second question about data" })).toBeNull();
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

  it("observes anchors that mount after the settle window without an observationKey change (MutationObserver)", () => {
    // The index already lists u3 (paginated, not loaded yet): the items
    // signature is final even though u3's DOM anchor does not exist yet.
    const items: ConversationNavItem[] = [
      { id: "u1", label: "One" },
      { id: "u2", label: "Two" },
      { id: "u3", label: "Three", before: "cursor-3" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    for (const id of ["u1", "u2"]) {
      const el = document.createElement("div");
      el.id = `user-msg-${id}`;
      root.appendChild(el);
    }
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
    const rootRef = { current: root };
    render(<ConversationNavRail items={items} rootRef={rootRef} onSelect={vi.fn()} />);
    const io = IOStub.instances[IOStub.instances.length - 1];
    expect(io.targets.map((target) => target.id)).toEqual(["user-msg-u1", "user-msg-u2"]);

    try {
      // u3 mounts well after the 150ms settle, with NO observationKey change
      // and NO rerender (Virtuoso's own virtualization commit): the rail's
      // MutationObserver must register it with the IntersectionObserver.
      const u3 = document.createElement("div");
      u3.id = "user-msg-u3";
      root.appendChild(u3);
      const mo = MOStub.instances[MOStub.instances.length - 1];
      act(() => {
        mo.cb([{ addedNodes: [u3], removedNodes: [] }] as unknown as MutationRecord[], mo as unknown as MutationObserver);
      });
      expect(io.targets.map((target) => target.id)).toEqual(["user-msg-u1", "user-msg-u2", "user-msg-u3"]);
    } finally {
      document.body.removeChild(root);
    }
  });

  it("re-registers the observer when anchors mount after the signature was known (observationKey)", () => {
    // The index already lists u3 (paginated, not loaded yet): the items
    // signature is final even though u3's DOM anchor does not exist yet.
    const items: ConversationNavItem[] = [
      { id: "u1", label: "One" },
      { id: "u2", label: "Two" },
      { id: "u3", label: "Three", before: "cursor-3" },
    ];
    const root = document.createElement("div");
    document.body.appendChild(root);
    for (const id of ["u1", "u2"]) {
      const el = document.createElement("div");
      el.id = `user-msg-${id}`;
      root.appendChild(el);
    }
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
    const rootRef = { current: root };
    const view = render(<ConversationNavRail items={items} rootRef={rootRef} onSelect={vi.fn()} observationKey="u1\u0000u2" />);
    const first = IOStub.instances[IOStub.instances.length - 1];
    expect(first.targets.map((target) => target.id)).toEqual(["user-msg-u1", "user-msg-u2"]);

    try {
      // The older page lands: u3's anchor mounts, and the page's loaded-user
      // signature grows. The unchanged items signature must not matter — the
      // rail has to observe the new anchor.
      const u3 = document.createElement("div");
      u3.id = "user-msg-u3";
      root.appendChild(u3);
      view.rerender(<ConversationNavRail items={items} rootRef={rootRef} onSelect={vi.fn()} observationKey="u1\u0000u2\u0000u3" />);
      const second = IOStub.instances[IOStub.instances.length - 1];
      expect(second).not.toBe(first);
      expect(second.targets.map((target) => target.id)).toEqual(["user-msg-u1", "user-msg-u2", "user-msg-u3"]);
    } finally {
      document.body.removeChild(root);
    }
  });
});

describe("ConversationNavRail attention hooks", () => {
  it("reports the active id only when it changes", () => {
    const onActiveChange = vi.fn();
    const root = document.createElement("div");
    for (const item of ITEMS) {
      const el = document.createElement("div");
      el.id = `user-msg-${item.id}`;
      root.appendChild(el);
    }
    Object.defineProperty(root, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
    render(<ConversationNavRail items={ITEMS} rootRef={{ current: root }} onSelect={vi.fn()} onActiveChange={onActiveChange} />);
    // Initial mount reports no active entry: nothing has been observed yet.
    expect(onActiveChange).toHaveBeenCalledTimes(1);
    expect(onActiveChange).toHaveBeenLastCalledWith(null);

    // The observer establishes the active entry from geometry.
    const io = IOStub.instances[IOStub.instances.length - 1];
    const target2 = document.createElement("div");
    target2.id = "user-msg-u2";
    Object.defineProperty(root, "scrollTop", { value: 500, configurable: true });
    act(() => {
      io.cb([{ target: target2, isIntersecting: true, intersectionRatio: 0.8 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(onActiveChange).toHaveBeenCalledTimes(2);
    expect(onActiveChange).toHaveBeenLastCalledWith("u2");

    // A later IO callback that resolves to the same active id does not re-fire.
    act(() => {
      io.cb([{ target: target2, isIntersecting: true, intersectionRatio: 0.8 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(onActiveChange).toHaveBeenCalledTimes(2);

    const target1 = document.createElement("div");
    target1.id = "user-msg-u1";
    act(() => {
      io.cb([{ target: target1, isIntersecting: true, intersectionRatio: 0.9 } as unknown as IntersectionObserverEntry], io as unknown as IntersectionObserver);
    });
    expect(onActiveChange).toHaveBeenCalledTimes(3);
    expect(onActiveChange).toHaveBeenLastCalledWith("u1");
  });

  it("marks user messages that carry an accepted bookmark", () => {
    renderRail(ITEMS, { bookmarkedIds: new Set(["u1"]) });
    // The marker is a decorative accent dot inside the u1 row.
    const row = screen.getByRole("button", { name: "First question about models" });
    expect(row.querySelector(".bg-accent")).not.toBeNull();
    const other = screen.getByRole("button", { name: "Second question about data" });
    expect(other.querySelector(".bg-accent")).toBeNull();
  });
});
