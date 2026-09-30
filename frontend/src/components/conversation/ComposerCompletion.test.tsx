import { useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentMention } from "../../lib/conversation";
import { queryClient } from "../../lib/client/query-client";
import { useUiStore } from "../../lib/ui";
import { MentionComposer } from "./MentionComposer";

/** A workspace the completion engine can see, keyed by subdir. */
const WORKSPACE: Record<string, Array<{ path: string; name: string; isDir: boolean; size: number; modified: number }>> = {
  "": [
    { path: "protein.csv", name: "protein.csv", isDir: false, size: 2048, modified: 0 },
    { path: "protein_old.csv", name: "protein_old.csv", isDir: false, size: 1024, modified: 0 },
    { path: "protein_structure", name: "protein_structure", isDir: true, size: 0, modified: 0 },
    { path: "notes.md", name: "notes.md", isDir: false, size: 512, modified: 0 },
  ],
  data: [
    { path: "data/protein.csv", name: "protein.csv", isDir: false, size: 4096, modified: 0 },
    { path: "data/dataset.csv", name: "dataset.csv", isDir: false, size: 8192, modified: 0 },
  ],
  results: [
    { path: "results/structures", name: "structures", isDir: true, size: 0, modified: 0 },
    { path: "results/result.csv", name: "result.csv", isDir: false, size: 256, modified: 0 },
  ],
  "results/structures": [
    { path: "results/structures/1abc.pdb", name: "1abc.pdb", isDir: false, size: 512, modified: 0 },
  ],
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

let filesFail = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/settings/subagents/discovery")) {
    return json({ agents: [
      { name: "reviewer", description: "Review work", source: "builtin" },
      { name: "scout", description: "Gather context", source: "builtin" },
    ] });
  }
  if (url.startsWith("/api/files/breadcrumbs")) return json([]);
  if (url.includes("/commands?")) {
    return json({ commands: [{ name: "skill:review", description: "Review files", source: "skill" }] });
  }
  if (url.startsWith("/api/files?")) {
    if (filesFail) return json({ detail: "workspace unavailable" }, 500);
    const subdir = new URLSearchParams(url.slice(url.indexOf("?"))).get("subdir") ?? "";
    return json(WORKSPACE[subdir] ?? []);
  }
  return json({}, 404);
});

const onKeyDown = vi.fn();

function Harness({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  const [mentions, setMentions] = useState<SubagentMention[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  return (
    <MentionComposer
      cwd="project"
      value={value}
      mentions={mentions}
      onChange={(next, nextMentions) => { setValue(next); setMentions(nextMentions); }}
      onKeyDown={onKeyDown}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      inputRef={inputRef}
      composingRef={composingRef}
      placeholder="Prompt"
    />
  );
}

function input(): HTMLTextAreaElement {
  return screen.getByPlaceholderText("Prompt");
}

function renderComposer(initialValue = "") {
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness initialValue={initialValue} />
    </QueryClientProvider>,
  );
}

/** Let the listing request, react-query's notify, and the caret's animation frame all land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(value: string, position = value.length): Promise<void> {
  fireEvent.change(input(), { target: { value } });
  input().setSelectionRange(position, position);
  fireEvent.select(input());
  await settle();
}

async function press(key: string, options: { shiftKey?: boolean } = {}): Promise<void> {
  fireEvent.keyDown(input(), { key, ...options });
  await settle();
}

beforeEach(() => {
  queryClient.clear();
  filesFail = false;
  onKeyDown.mockClear();
  useUiStore.setState({ workspaceReferences: [] });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("composer completion keyboard paths", () => {
  it("TC-01 accepts a slash command with Tab and leaves a trailing space", async () => {
    renderComposer();
    await type("/exp");
    await press("Tab");
    expect(input()).toHaveValue("/export ");
  });

  it("keeps Enter accepting a slash command so it reaches send only on the next press", async () => {
    renderComposer();
    await type("/exp");
    await press("Enter");
    expect(input()).toHaveValue("/export ");
    expect(onKeyDown).not.toHaveBeenCalled();

    await press("Enter");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onKeyDown.mock.calls[0][0].key).toBe("Enter");
  });

  it("does not swallow keys pressed outside the composer", async () => {
    renderComposer();
    await type("@rev");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    const outsideKey = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(outsideKey);

    expect(outsideKey.defaultPrevented).toBe(false);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("TC-02 completes a command argument with Tab", async () => {
    renderComposer();
    await type("/export j");
    await press("Tab");
    expect(input()).toHaveValue("/export jsonl");
  });

  it("TC-03 accepts a discovered skill command with Tab", async () => {
    const { fetchDynamicCommands } = await import("../../lib/conversation");
    await act(async () => { await fetchDynamicCommands("s1", "project"); });

    renderComposer();
    await type("/skill:rev");
    await press("Tab");
    expect(input()).toHaveValue("/skill:review");
  });

  it("TC-04 completes a workspace file path with Tab", async () => {
    renderComposer();
    await type("data/pro");
    await press("Tab");
    expect(input()).toHaveValue("data/protein.csv");
    expect(input().selectionStart).toBe("data/protein.csv".length);
  });

  it("TC-05 fills the common prefix first and opens the candidates on the second Tab", async () => {
    renderComposer();
    await type("pro");
    await press("Tab");
    expect(input()).toHaveValue("protein");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await press("Tab");
    const listbox = screen.getByRole("listbox");
    const labels = [...listbox.querySelectorAll("[role='option']")].map((option) => option.querySelector("span")?.textContent);
    // Directories lead, and nothing outside the prefix leaks into the list.
    expect(labels[0]).toBe("protein_structure/");
    expect(new Set(labels)).toEqual(new Set(["protein_structure/", "protein.csv", "protein_old.csv"]));
    expect(input()).toHaveValue("protein");
  });

  it("TC-06 leaves Tab to the browser when nothing matches", async () => {
    renderComposer();
    await type("hello");
    await press("Tab");
    expect(input()).toHaveValue("hello");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onKeyDown.mock.calls[0][0].defaultPrevented).toBe(false);
  });

  it("TC-07 keeps the existing @subagent mention behavior, Tab included", async () => {
    renderComposer();
    await type("@rev");
    await press("Tab");
    await waitFor(() => expect(input()).toHaveValue("@reviewer "));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("turns an already-complete @name into a mention even when the text does not change", async () => {
    const { container } = renderComposer("@reviewer text");
    await type("@reviewer text", 9);
    await press("Tab");
    const mirror = container.querySelector("[aria-hidden='true']");
    await waitFor(() => expect(mirror?.querySelector("span")?.textContent).toBe("@reviewer"));
    expect(input()).toHaveValue("@reviewer text");
  });

  it("replaces the whole token when the caret sits in the middle of it", async () => {
    renderComposer();
    await type("data/proX", 8);
    await press("Tab");
    expect(input()).toHaveValue("data/protein.csv");
  });

  it("leaves Tab alone when the token already names its only candidate", async () => {
    renderComposer();
    await type("report.md");
    await press("Tab");
    expect(input()).toHaveValue("report.md");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onKeyDown.mock.calls[0][0].defaultPrevented).toBe(false);
  });

  it("offers both argument values when the command name is complete and Tab asks for them", async () => {
    renderComposer();
    await type("/export ");
    await press("Tab");
    const labels = [...screen.getByRole("listbox").querySelectorAll("[role='option']")].map((option) => option.querySelector("span")?.textContent);
    expect(labels).toEqual(["html", "jsonl"]);

    await press("Tab");
    expect(input()).toHaveValue("/export html");
  });

  it("continues a directory completion into the next level", async () => {
    renderComposer();
    await type("results/str");
    await press("Tab");
    expect(input()).toHaveValue("results/structures/");

    await type("results/structures/1abc");
    await press("Tab");
    expect(input()).toHaveValue("results/structures/1abc.pdb");
  });

  it("navigates the candidate list with the arrow keys and accepts with Enter", async () => {
    renderComposer();
    await type("@");
    const listbox = screen.getByRole("listbox");
    expect(input().getAttribute("aria-activedescendant")).toBe(`${listbox.id}-option-0`);

    await press("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(`${listbox.id}-option-1`);
    await press("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe(`${listbox.id}-option-0`);

    await press("ArrowDown");
    await press("Enter");
    await waitFor(() => expect(input()).toHaveValue("@scout "));
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("dismisses the candidate list with Escape and keeps the typed text", async () => {
    renderComposer();
    await type("pro");
    await press("Tab");
    await press("Tab");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await press("Escape");
    expect(input()).toHaveValue("protein");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps a dismissed list closed while the same token keeps growing", async () => {
    renderComposer();
    await type("@rev");
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await press("Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await type("@revi");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input()).toHaveValue("@revi");
  });

  it("reopens a dismissed list once the token is replaced", async () => {
    renderComposer();
    await type("@rev");
    await press("Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await type("");
    await type("@rev");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("brings a dismissed list back with Tab", async () => {
    renderComposer();
    await type("@rev");
    await press("Escape");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await press("Tab");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input()).toHaveValue("@rev");
  });

  it("names a mixed candidate list as completions and an agents-only list as subagents", async () => {
    renderComposer();
    await type("@data/pro");
    expect(screen.getByRole("listbox", { name: "Completions" })).toBeInTheDocument();

    await type("@rev");
    expect(screen.getByRole("listbox", { name: "Subagents" })).toBeInTheDocument();
  });

  it("turns an @file candidate into a workspace reference instead of text", async () => {
    renderComposer();
    await type("@data/pro");
    await press("Tab");
    await waitFor(() => expect(useUiStore.getState().workspaceReferences).toEqual([
      { cwd: "project", path: "data/protein.csv", name: "protein.csv", isDir: false },
    ]));
    expect(input()).toHaveValue("");
  });

  it("lets Enter send when the list is closed", async () => {
    renderComposer();
    await type("hello");
    await press("Enter");
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onKeyDown.mock.calls[0][0].key).toBe("Enter");
  });

  it("leaves every key to the IME while it composes", async () => {
    renderComposer();
    await type("/exp");
    fireEvent.compositionStart(input());
    await press("Tab");
    expect(input()).toHaveValue("/exp");
    expect(onKeyDown).toHaveBeenCalledTimes(1);

    await press("Enter");
    expect(input()).toHaveValue("/exp");
    expect(onKeyDown).toHaveBeenCalledTimes(2);
    expect(onKeyDown.mock.calls[1][0].defaultPrevented).toBe(false);
  });

  it("keeps typing when the file API fails", async () => {
    filesFail = true;
    renderComposer();
    await type("data/pro");
    expect(input()).toHaveValue("data/pro");
    await press("Tab");
    expect(input()).toHaveValue("data/pro");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
