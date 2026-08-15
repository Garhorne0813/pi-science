import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentMention } from "../../lib/conversation";
import { queryClient } from "../../lib/client/query-client";
import { MentionComposer } from "./MentionComposer";

const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
  agents: [
    { name: "reviewer", description: "Review work", source: "builtin" },
    { name: "scout", description: "Gather context", source: "builtin" },
  ],
}), { status: 200, headers: { "Content-Type": "application/json" } }));

function Harness() {
  const [value, setValue] = useState("");
  const [mentions, setMentions] = useState<SubagentMention[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <MentionComposer
      cwd="project"
      value={value}
      mentions={mentions}
      onChange={(next, nextMentions) => { setValue(next); setMentions(nextMentions); }}
      onKeyDown={() => undefined}
      onCompositionStart={() => undefined}
      onCompositionEnd={() => undefined}
      inputRef={inputRef}
      placeholder="Prompt"
    />
  );
}

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Prompt");
}

async function typeAt(value: string, position = value.length) {
  fireEvent.change(input(), { target: { value } });
  input().setSelectionRange(position, position);
  fireEvent.select(input());
  await Promise.resolve();
}

describe("MentionComposer", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("shares discovery loading across composers in the same workspace", async () => {
    const first = render(<Harness />);
    const second = render(<Harness />);

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/settings/subagents/discovery")).length).toBe(1));

    first.unmount();
    second.unmount();
  });

  it("dismisses the menu with Escape or an outside click and keeps @ as text", async () => {
    render(<Harness />);
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

  it("inserts multiple highlighted mentions and deletes a mention atomically", async () => {
    const { container } = render(<Harness />);
    await typeAt("@rev");
    fireEvent.click(await screen.findByRole("option", { name: /@reviewer/ }));
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    expect(container.querySelector("span")?.textContent).toBe("@reviewer");

    await typeAt("@reviewer @sco");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(input()).toHaveValue("@reviewer @scout "));
    expect([...container.querySelectorAll("span")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["@reviewer", "@scout"]));

    input().setSelectionRange("@reviewer".length, "@reviewer".length);
    fireEvent.change(input(), { target: { value: "@reviewe @scout " } });
    await waitFor(() => expect(input()).toHaveValue(" @scout "));
    expect(container.textContent).not.toContain("@reviewer");
  });

  it("scrolls the active subagent into view while navigating", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(<Harness />);
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
    render(<Harness />);
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
});
