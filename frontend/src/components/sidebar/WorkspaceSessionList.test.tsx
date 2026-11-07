import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { FeedbackProvider } from "../feedback/FeedbackProvider";
import { WorkspaceSessionList } from "./WorkspaceSessionList";

const cwd = "/workspace";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useRuntimeStore.setState({
    cwd,
    sessions: [{ id: "session-a", cwd, name: "Alpha" }, { id: "session-b", cwd, name: "Beta" }],
    activeSessionId: null,
    working: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function LocationProbe() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={["/elsewhere"]}>
      <FeedbackProvider>
        <WorkspaceSessionList cwd={cwd} />
        <LocationProbe />
      </FeedbackProvider>
    </MemoryRouter>,
  );
}

async function openMenu(name: string) {
  const trigger = screen.getByRole("button", { name: `Manage conversation: ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  return screen.findByRole("menu");
}

async function openRename(name: string) {
  const menu = await openMenu(name);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename conversation" }));
  return within(await screen.findByRole("dialog")).getByLabelText("Rename conversation");
}

describe("conversation menu actions", () => {
  it("lists rename, regenerate, fork and delete in order without navigating", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderList();

    const menu = await openMenu("Alpha");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename conversation",
      "Regenerate title with AI",
      "Fork conversation",
      "Delete conversation",
    ]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename conversation" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/elsewhere");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefills the rename dialog with the title shown in the list", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderList();
    expect(await openRename("Alpha")).toHaveValue("Alpha");
  });

  it("disables save for whitespace-only and over-long titles", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderList();
    const input = await openRename("Alpha");
    const save = screen.getByRole("button", { name: "Save" });

    fireEvent.change(input, { target: { value: "   " } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "x".repeat(51) } });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: "x".repeat(50) } });
    expect(save).toBeEnabled();
    fireEvent.change(input, { target: { value: "  Two   words " } });
    expect(save).toBeEnabled();
  });

  it("closes on Escape without sending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderList();
    const input = await openRename("Alpha");

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes without a request when the title did not change", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderList();
    await openRename("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates the row after the server confirms the new title", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, title: "Renamed" }));
    vi.stubGlobal("fetch", fetchMock);
    renderList();
    const input = await openRename("Alpha");

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Manage conversation: Renamed" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/sessions/session-a/title?cwd=${encodeURIComponent(cwd)}`);
  });

  it("keeps the dialog, the typed title and the error when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "boom" }, 500)));
    renderList();
    const input = await openRename("Alpha");

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Renamed");
    expect(screen.getByRole("button", { name: "Manage conversation: Alpha" })).toBeInTheDocument();
  });

  it("disables only the regenerating session while its title request is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderList();

    const menu = await openMenu("Alpha");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Regenerate title with AI" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    const pendingMenu = await openMenu("Alpha");
    const pendingItem = within(pendingMenu).getByRole("menuitem", { name: "Regenerate title with AI" });
    expect(pendingItem).toHaveAttribute("aria-disabled", "true");
    expect(pendingItem.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.keyDown(pendingMenu, { key: "Escape" });

    const otherMenu = await openMenu("Beta");
    expect(within(otherMenu).getByRole("menuitem", { name: "Regenerate title with AI" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("disables regenerate for the running session only", async () => {
    vi.stubGlobal("fetch", vi.fn());
    useRuntimeStore.setState({ activeSessionId: "session-a", working: true });
    renderList();

    const menu = await openMenu("Alpha");
    expect(within(menu).getByRole("menuitem", { name: "Regenerate title with AI" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(menu, { key: "Escape" });

    const otherMenu = await openMenu("Beta");
    expect(within(otherMenu).getByRole("menuitem", { name: "Regenerate title with AI" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("shows the title the regeneration produced", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, title: "AlphaFold structural analysis", revision: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    renderList();

    const menu = await openMenu("Alpha");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Regenerate title with AI" }));

    expect(await screen.findByRole("button", { name: "Manage conversation: AlphaFold structural analysis" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("keeps the generating indicator on the row after the menu closes", async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { release = done; })));
    renderList();

    const menu = await openMenu("Alpha");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Regenerate title with AI" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    // The menu is gone, the request is not: the row still says so.
    expect(screen.getByRole("status")).toHaveTextContent("Generating title");
    expect(screen.getByRole("button", { name: "Manage conversation: Alpha" })).toBeInTheDocument();

    release(jsonResponse({ ok: true, title: "AlphaFold", revision: 1 }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Manage conversation: AlphaFold" })).toBeInTheDocument();
  });

  it("drops the generating indicator on failure and keeps the old title", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "boom" }, 500)));
    renderList();

    const menu = await openMenu("Alpha");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Regenerate title with AI" }));

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Manage conversation: Alpha" })).toBeInTheDocument();
    expect(await screen.findByText("Unable to generate a title")).toBeInTheDocument();
  });

  it("ends a cancelled regeneration silently", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, title: null, superseded: true })));
    renderList();

    const menu = await openMenu("Alpha");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Regenerate title with AI" }));

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Manage conversation: Alpha" })).toBeInTheDocument();
    expect(screen.queryByText("Unable to generate a title")).not.toBeInTheDocument();
  });

  it("sends one rename request when Enter is pressed twice while saving", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((done) => { release = done; }));
    vi.stubGlobal("fetch", fetchMock);
    renderList();
    const input = await openRename("Alpha");

    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(input).toBeDisabled();

    release(jsonResponse({ ok: true, title: "Renamed" }));
    expect(await screen.findByRole("button", { name: "Manage conversation: Renamed" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
