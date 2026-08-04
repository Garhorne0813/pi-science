import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentMention } from "../../lib/conversation";
import { MentionComposer } from "./MentionComposer";

const fetchMock = vi.fn(async () => new Response(JSON.stringify({
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
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

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
});
