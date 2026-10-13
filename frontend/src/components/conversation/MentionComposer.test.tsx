import { useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentMention } from "../../lib/conversation";
import type { ComposerEntity } from "../../lib/conversation/composer-document";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";
import { MentionComposer } from "./MentionComposer";

let fileFixture: Map<string, Array<{ name: string; path: string; isDir: boolean; size: number }>> | null = null;
let observedEntities: ComposerEntity[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/files?") && fileFixture) {
    const subdir = new URL(url, "http://localhost").searchParams.get("subdir") ?? "";
    return new Response(JSON.stringify(fileFixture.get(subdir) ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.startsWith("/api/files/breadcrumbs?") && fileFixture) {
    const subdir = new URL(url, "http://localhost").searchParams.get("subdir") ?? "";
    const breadcrumbs = subdir ? subdir.split("/").map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") })) : [];
    return new Response(JSON.stringify(breadcrumbs), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({
    agents: [
      { name: "reviewer", description: "Review work", source: "builtin" },
      { name: "scout", description: "Gather context", source: "builtin" },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});

function Harness({ initialValue = "", initialEntities = [] }: { initialValue?: string; initialEntities?: ComposerEntity[] }) {
  const [value, setValue] = useState(initialValue);
  const [mentions, setMentions] = useState<SubagentMention[]>([]);
  const [entities, setEntities] = useState<ComposerEntity[]>(initialEntities);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  return (
    <MentionComposer
      cwd="project"
      value={value}
      mentions={mentions}
      entities={entities}
      onChange={(next, nextMentions, nextEntities) => { observedEntities = nextEntities; setValue(next); setMentions(nextMentions); setEntities(nextEntities); }}
      onKeyDown={() => undefined}
      onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
      onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; setComposing(false); }, 0); }}
      inputRef={inputRef}
      composing={composing}
      composingRef={composingRef}
      placeholder="Prompt"
    />
  );
}

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Prompt");
}

async function typeAt(value: string, position = value.length) {
  const element = input();
  const previous = element.value;
  let start = 0;
  let oldEnd = previous.length;
  let newEnd = value.length;
  if (value.startsWith(previous)) {
    start = oldEnd = previous.length;
    newEnd = value.length;
  } else if (previous.startsWith(value)) {
    start = 0;
    oldEnd = previous.length;
    newEnd = value.length;
  } else {
    while (start < previous.length && start < value.length && previous[start] === value[start]) start += 1;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
  }
  element.setSelectionRange(start, oldEnd);
  const inputType = value.length < previous.length && newEnd === start ? "deleteContentBackward" : "insertText";
  fireEvent(element, new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
  fireEvent.change(element, { target: { value } });
  input().setSelectionRange(position, position);
  fireEvent.select(input());
  await Promise.resolve();
}

const referenceEntity: ComposerEntity = { kind: "reference", id: "protein", start: 7, end: 24, reference: { cwd: "project", path: "data/protein.csv", name: "protein.csv", isDir: false } };

function renderComposer(initialValue = "", initialEntities: ComposerEntity[] = []) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness initialValue={initialValue} initialEntities={initialEntities} />
    </QueryClientProvider>,
  );
}

describe("MentionComposer", () => {
  // The listbox carries a translated accessible name, so this file initialises i18n itself
  // instead of relying on a side effect of an unrelated import.
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    queryClient.clear();
    fileFixture = null;
    observedEntities = [];
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    queryClient.clear();
    fileFixture = null;
    vi.unstubAllGlobals();
  });

  it("shares discovery loading across composers in the same workspace", async () => {
    const first = renderComposer();
    const second = renderComposer();

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/subagents/discovery")).length).toBe(1));

    first.unmount();
    second.unmount();
  });

  it("dismisses the menu with Escape or an outside click and keeps @ as text", async () => {
    renderComposer();
    await typeAt("@");
    expect(await screen.findByRole("listbox", { name: "Subagents" })).toBeInTheDocument();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("@");
    expect(screen.queryByRole("listbox", { name: "Subagents" })).not.toBeInTheDocument();

    await typeAt("x @", 3);
    expect(await screen.findByRole("listbox", { name: "Subagents" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(input()).toHaveValue("x @");
    expect(screen.queryByRole("listbox", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("browses folders without binding and binds only explicit file or directory choices", async () => {
    fileFixture = new Map([
      ["", [
        { name: "structures", path: "structures", isDir: true, size: 0 },
        { name: "readme.txt", path: "readme.txt", isDir: false, size: 12 },
      ]],
      ["structures", [
        { name: "nested", path: "structures/nested", isDir: true, size: 0 },
        { name: "WT.pdb", path: "structures/WT.pdb", isDir: false, size: 100 },
      ]],
    ]);
    renderComposer();
    await typeAt("@");
    const openFolder = await screen.findByRole("option", { name: /structures.*Open folder/ });
    fireEvent.click(openFolder);

    expect(input()).toHaveValue("@");
    const mirror = input().parentElement?.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")).toBeNull();
    await screen.findByRole("button", { name: "structures" });

    const fileOption = screen.getByRole("option", { name: /WT\.pdb/ });
    expect(fileOption).toHaveTextContent("Reference");
    fireEvent.click(fileOption);
    await waitFor(() => expect(input()).toHaveValue("@structures/WT.pdb "));
    expect(observedEntities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "reference",
        start: 0,
        end: "@structures/WT.pdb".length,
        reference: expect.objectContaining({ path: "structures/WT.pdb", isDir: false }),
      }),
    ]));
    expect(mirror?.querySelector("span")?.textContent).toBe("@structures/WT.pdb");

    await typeAt("@");
    fireEvent.click(await screen.findByRole("option", { name: /Reference entire folder/ }));
    await waitFor(() => expect(input()).toHaveValue("@structures "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@structures");
  });

  it("crosses a highlighted entity in one arrow press from either boundary", () => {
    const { container } = renderComposer("before @data/protein.csv after", [referenceEntity]);
    const composer = input();
    composer.setSelectionRange(24, 24);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft" })).toBe(false);
    expect(composer.selectionStart).toBe(7);
    expect(composer.selectionEnd).toBe(7);
    expect(container.querySelector("[aria-hidden='true'] span")?.textContent).toBe("@data/protein.csv");

    expect(fireEvent.keyDown(composer, { key: "ArrowRight" })).toBe(false);
    expect(composer.selectionStart).toBe(24);
    expect(composer.selectionEnd).toBe(24);
    expect(container.querySelector("[aria-hidden='true'] span")?.textContent).toBe("@data/protein.csv");
  });

  it("crosses the entity when ArrowLeft follows native movement to its right boundary", () => {
    const { container } = renderComposer("@data/protein.csv ", [{ ...referenceEntity, start: 0, end: 17 }]);
    const composer = input();
    composer.setSelectionRange(18, 18);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft" })).toBe(true);
    composer.setSelectionRange(17, 17);
    fireEvent.select(composer);
    expect(composer.selectionStart).toBe(17);
    expect(composer.selectionEnd).toBe(17);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft" })).toBe(false);
    expect(composer.selectionStart).toBe(0);
    expect(composer.selectionEnd).toBe(0);
    expect(container.querySelector("[aria-hidden='true'] span")?.textContent).toBe("@data/protein.csv");
  });

  it("keeps Shift+ArrowLeft native and expands its backward selection to the entity edges", () => {
    const { container } = renderComposer("@data/protein.csv ", [{ ...referenceEntity, start: 0, end: 17 }]);
    const composer = input();
    composer.setSelectionRange(18, 18);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft" })).toBe(true);
    composer.setSelectionRange(17, 17);
    fireEvent.select(composer);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft", shiftKey: true })).toBe(true);
    composer.setSelectionRange(16, 17, "backward");
    fireEvent.select(composer);
    expect({ start: composer.selectionStart, end: composer.selectionEnd, direction: composer.selectionDirection }).toEqual({ start: 0, end: 17, direction: "backward" });
    expect(container.querySelector("[aria-hidden='true'] span")?.textContent).toBe("@data/protein.csv");
  });

  it("crosses adjacent entities one at a time in both directions", () => {
    const { container } = renderComposer("before @data/protein.csv@scout after", [referenceEntity, { kind: "mention", id: "scout", name: "scout", start: 24, end: 30 }]);
    const composer = input();
    composer.setSelectionRange(30, 30);
    fireEvent.keyDown(composer, { key: "ArrowLeft" });
    expect(composer.selectionStart).toBe(24);
    expect(composer.selectionEnd).toBe(24);
    fireEvent.keyDown(composer, { key: "ArrowLeft" });
    expect(composer.selectionStart).toBe(7);
    expect(composer.selectionEnd).toBe(7);
    fireEvent.keyDown(composer, { key: "ArrowRight" });
    expect(composer.selectionStart).toBe(24);
    expect(composer.selectionEnd).toBe(24);
    fireEvent.keyDown(composer, { key: "ArrowRight" });
    expect(composer.selectionStart).toBe(30);
    expect(composer.selectionEnd).toBe(30);
    expect([...container.querySelectorAll("[aria-hidden='true'] span")].map((node) => node.textContent)).toEqual(["@data/protein.csv", "@scout"]);
  });

  it("leaves plain-text arrows and modified arrows to the browser", () => {
    renderComposer("before @data/protein.csv after", [referenceEntity]);
    const composer = input();
    composer.setSelectionRange(3, 3);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft" })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "ArrowRight" })).toBe(true);
    expect(composer.selectionStart).toBe(3);
    expect(composer.selectionEnd).toBe(3);
    composer.setSelectionRange(24, 24);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft", altKey: true })).toBe(true);
    expect(composer.selectionStart).toBe(24);
    expect(composer.selectionEnd).toBe(24);
  });

  it("does not handle entity navigation or undo while the IME composes", () => {
    const { container } = renderComposer("before @data/protein.csv after", [referenceEntity]);
    const composer = input();
    composer.setSelectionRange(24, 24);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft", isComposing: true })).toBe(true);
    fireEvent.compositionStart(composer);
    expect(fireEvent.keyDown(composer, { key: "ArrowLeft" })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "z", ctrlKey: true })).toBe(true);
    expect(composer.selectionStart).toBe(24);
    expect(composer.selectionEnd).toBe(24);
    composer.setSelectionRange(7, 7);
    expect(fireEvent.keyDown(composer, { key: "ArrowRight" })).toBe(true);
    expect(composer.selectionStart).toBe(7);
    expect(composer.selectionEnd).toBe(7);
    expect(composer.value).toBe("before @data/protein.csv after");
    expect(container.querySelector("[aria-hidden='true'] span")?.textContent).toBe("@data/protein.csv");
  });

  it("snaps pointer selections inside an entity to the nearer boundary", () => {
    renderComposer("before @data/protein.csv after", [referenceEntity]);
    const composer = input();
    fireEvent.pointerDown(composer);
    composer.setSelectionRange(8, 8);
    fireEvent.select(composer);
    expect(composer.selectionStart).toBe(7);
    expect(composer.selectionEnd).toBe(7);
    fireEvent.pointerDown(composer);
    composer.setSelectionRange(23, 23);
    fireEvent.select(composer);
    expect(composer.selectionStart).toBe(24);
    expect(composer.selectionEnd).toBe(24);
  });

  it("preserves the current backward direction when extending across an entity", () => {
    renderComposer("before @data/protein.csv after", [referenceEntity]);
    const composer = input();
    composer.setSelectionRange(23, 29, "backward");
    fireEvent.select(composer);
    expect(composer.selectionStart).toBe(7);
    expect(composer.selectionEnd).toBe(29);
    expect(composer.selectionDirection).toBe("backward");
  });

  it("places a completion caret inside a sentence on the same commit", async () => {
    fileFixture = new Map([["data", [{ name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 }]]]);
    renderComposer();
    await typeAt("before @data/pro after", 16);
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));

    // No frame is awaited: the placement belongs to the commit that carries the text, so nothing can
    // type or move the caret at the position the browser left behind.
    expect(input().value).toBe("before @data/protein.csv after");
    expect(input().selectionStart).toBe(24);
    expect(input().selectionEnd).toBe(24);
  });

  it("places an accepted completion caret before any observer can run", async () => {
    fileFixture = new Map([["data", [{ name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 }]]]);
    renderComposer();
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));

    expect(input().value).toBe("@data/protein.csv ");
    expect(input().selectionStart).toBe(18);
    expect(input().selectionEnd).toBe(18);
    expect(document.activeElement?.getAttribute("placeholder")).toBe("Prompt");
  });

  it("keeps a pointer selection that follows a completion", async () => {
    fileFixture = new Map([["data", [{ name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 }]]]);
    const { container } = renderComposer();
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));
    expect(input().selectionStart).toBe(18);

    fireEvent.pointerDown(input());
    input().setSelectionRange(0, 0);
    fireEvent.select(input());

    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(0);
    expect(container.querySelector("[aria-hidden='true'] span")?.textContent).toBe("@data/protein.csv");
  });

  it("does not take focus back after the user moved it away from the composer", async () => {
    fileFixture = new Map([["data", [{ name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 }]]]);
    renderComposer();
    render(<button>Settings</button>);
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));

    act(() => screen.getByRole("button", { name: "Settings" }).focus());
    input().setSelectionRange(0, 0);

    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(0);
    expect(document.activeElement?.textContent).toBe("Settings");
  });

  /** The caret is already inside the token when the arrow key that moved it is processed, which is the
   *  state the handler sees. React also synthesises an onSelect from the keydown itself, so the crossing
   *  has to hold whichever of the two selects consumes the direction. */
  async function acceptAndPlaceInside(position: number): Promise<void> {
    fileFixture = new Map([["data", [
      { name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 },
    ]]]);
    renderComposer();
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    input().setSelectionRange(position, position);
  }

  it("crosses the reference backwards when a word-wise move enters it", async () => {
    // 12 sits in the right half, where the pointer rule would snap forward to 17.
    await acceptAndPlaceInside(12);
    fireEvent.keyDown(input(), { key: "ArrowLeft", altKey: true });
    fireEvent.select(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(0);
  });

  it("crosses the reference forwards when a word-wise move enters it", async () => {
    // 8 sits in the left half, where the pointer rule would snap back to 0.
    await acceptAndPlaceInside(8);
    fireEvent.keyDown(input(), { key: "ArrowRight", altKey: true });
    fireEvent.select(input());
    expect(input().selectionStart).toBe(17);
    expect(input().selectionEnd).toBe(17);
  });

  it("keeps the nearest-half rule for a selection that no key announced", async () => {
    await acceptAndPlaceInside(12);
    input().setSelectionRange(12, 12);
    fireEvent.select(input());
    expect(input().selectionStart).toBe(17);
    expect(input().selectionEnd).toBe(17);
  });

  it("takes the undo and redo chords because the platform stops offering its own redo", async () => {
    fileFixture = new Map([["data", [
      { name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 },
    ]]]);
    const { container } = renderComposer();
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")?.textContent).toBe("@data/protein.csv");

    fireEvent.keyDown(input(), { key: "z", metaKey: true });
    await waitFor(() => expect(input()).toHaveValue("@data/pro"));
    expect(mirror?.querySelector("span")).toBeNull();

    fireEvent.keyDown(input(), { key: "Z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@data/protein.csv");
  });

  it("undoes and redoes a file reference together with its identity", async () => {
    fileFixture = new Map([["data", [
      { name: "protein.csv", path: "data/protein.csv", isDir: false, size: 12 },
    ]]]);
    const { container } = renderComposer();
    await typeAt("@data/pro");
    fireEvent.click(await screen.findByRole("option", { name: /protein\.csv/ }));
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")?.textContent).toBe("@data/protein.csv");

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@data/pro"));
    expect(mirror?.querySelector("span")).toBeNull();

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@data/protein.csv "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@data/protein.csv");
  });

  it("inserts multiple highlighted mentions and deletes a mention atomically", async () => {
    const { container } = renderComposer();
    await typeAt("@rev");
    fireEvent.click(await screen.findByRole("option", { name: /@reviewer/ }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    expect(container.querySelector("span")?.textContent).toBe("@reviewer");

    await typeAt("@reviewer @sco");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(input()).toHaveValue("@reviewer @scout "));
    expect([...container.querySelectorAll("span")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["@reviewer", "@scout"]));

    input().setSelectionRange("@reviewer".length, "@reviewer".length);
    fireEvent(input(), new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
    fireEvent.change(input(), { target: { value: "@reviewe @scout " } });
    await waitFor(() => expect(input()).toHaveValue(" @scout "));
    expect(container.textContent).not.toContain("@reviewer");
  });

  it("undoes and redoes a mention together with its bound identity", async () => {
    const { container } = renderComposer();
    await typeAt("@rev");
    fireEvent.click(await screen.findByRole("option", { name: /@reviewer/ }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(mirror?.querySelector("span")?.textContent).toBe("@reviewer");

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyUndo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@rev"));
    expect(mirror?.querySelector("span")).toBeNull();

    fireEvent(input(), new InputEvent("beforeinput", { inputType: "historyRedo", bubbles: true, cancelable: true }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    expect(mirror?.querySelector("span")?.textContent).toBe("@reviewer");
  });

  it("scrolls the active subagent into view while navigating", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    renderComposer();
    await typeAt("@");
    await screen.findByRole("listbox", { name: "Subagents" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });

    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("wires the textarea to the listbox as a combobox (aria-controls/activedescendant)", async () => {
    renderComposer();
    await typeAt("@");
    const listbox = await screen.findByRole("listbox", { name: "Subagents" });

    expect(input()).toHaveAttribute("role", "combobox");
    expect(input()).toHaveAttribute("aria-label", "Message");
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input().getAttribute("aria-controls")).toBe(listbox.id);
    // Active descendant points at the first option (activeIndex resets to 0).
    const activeId = input().getAttribute("aria-activedescendant");
    expect(activeId).toBe(`${listbox.id}-option-0`);
    expect(listbox.querySelector<HTMLElement>(`#${activeId}`)).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(input().getAttribute("aria-activedescendant")).toBe(`${listbox.id}-option-1`);
  });

  it("grows with its content, scrolls at the maximum height, and shrinks again", async () => {
    renderComposer();
    const composer = input();

    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 120 });
    await typeAt("one\ntwo\nthree");
    expect(composer.style.height).toBe("120px");
    expect(composer.style.overflowY).toBe("hidden");

    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 240 });
    await typeAt("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
    expect(composer.style.height).toBe("160px");
    expect(composer.style.overflowY).toBe("auto");

    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 20 });
    await typeAt("");
    expect(composer.style.height).toBe("64px");
    expect(composer.style.overflowY).toBe("hidden");
  });

  it("keeps the latest line visible when appending beyond the maximum height", async () => {
    const { container } = renderComposer();
    const composer = input();
    const mirror = container.querySelector<HTMLElement>("[aria-hidden='true']");
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 240 });

    await typeAt("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");

    expect(composer.scrollTop).toBe(240);
    expect(mirror?.scrollTop).toBe(240);
  });

  it("preserves the scroll position when editing earlier overflowing text", async () => {
    renderComposer();
    const composer = input();
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 240 });
    await typeAt("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");

    composer.scrollTop = 36;
    composer.setSelectionRange(3, 3);
    fireEvent.change(composer, { target: { value: "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight", selectionStart: 3, selectionEnd: 3 } });

    expect(composer.scrollTop).toBe(36);
  });

  it("clips mirrored text and the textarea scrollbar inside the composer corners", () => {
    const { container } = renderComposer();
    const clippingFrame = input().parentElement;
    const mirror = container.querySelector("[aria-hidden='true']");

    expect(clippingFrame).toHaveClass("overflow-hidden", "rounded-t-composer");
    expect(mirror).toHaveClass("[clip-path:inset(8px_12px)]");
  });
});

