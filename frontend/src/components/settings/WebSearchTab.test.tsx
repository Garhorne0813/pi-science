import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { WebSearchTab } from "./WebSearchTab";

let state = { search_enabled: true, fetch_enabled: true, provider: "brave", api_keys: { brave: true } };
let writes: Record<string, unknown>[] = [];
let failSave = false;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  state = { search_enabled: true, fetch_enabled: true, provider: "brave", api_keys: { brave: true } }; writes = []; failSave = false;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PUT") {
      const patch = JSON.parse(init.body); writes.push(patch);
      if (failSave) return Response.json({ ok: false, error: "Reload failed" });
      state = { ...state, ...patch, api_keys: { ...state.api_keys, ...Object.fromEntries(Object.entries(patch.api_keys ?? {}).map(([name, value]) => [name, Boolean(value)])) } };
    }
    return Response.json({ ok: true, web_access: state, session_replacements: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("saves switches without resending or exposing a configured key", async () => {
  render(<WebSearchTab />);
  const checkbox = await screen.findByRole("checkbox", { name: "Enable web search" });
  expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  expect(screen.getByLabelText("API key")).toHaveValue("");
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings saved");
  expect(writes).toEqual([{ search_enabled: false, fetch_enabled: true, provider: "brave" }]);
});
it("replaces and removes the selected provider key", async () => {
  render(<WebSearchTab />);
  const key = await screen.findByLabelText("API key");
  fireEvent.change(key, { target: { value: "replacement-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings saved");
  expect(writes[0].api_keys).toEqual({ brave: "replacement-key" });
  expect(key).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Remove saved key" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].api_keys).toEqual({ brave: "" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove saved key" })).not.toBeInTheDocument());
});
it("keeps edits available after save errors and clears unsaved keys when switching providers", async () => {
  render(<WebSearchTab />);
  const key = await screen.findByLabelText("API key");
  fireEvent.change(key, { target: { value: "brave-only-key" } });
  const provider = screen.getByRole("button", { name: /^Search provider:/ });
  fireEvent.pointerDown(provider); fireEvent.click(provider);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Exa" }));
  expect(key).toHaveValue("");
  failSave = true;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Reload failed");
  expect(screen.getByRole("button", { name: /^Search provider:/ })).toHaveTextContent("Exa");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("offers DeepSeek with Search/Fetch guidance and saves its own API key", async () => {
  render(<WebSearchTab />);
  const provider = await screen.findByRole("button", { name: /^Search provider:/ });
  fireEvent.pointerDown(provider); fireEvent.click(provider);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "DeepSeek" }));
  expect(screen.getByText(/Uses DeepSeek Search and Fetch/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "deepseek-fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Settings saved");
  expect(writes[0]).toMatchObject({ provider: "deepseek", api_keys: { deepseek: "deepseek-fixture" } });
  expect(screen.getByLabelText("API key")).toHaveValue("");
});

it("collapses shared provider settings only when both tools are off and keeps values", async () => {
  render(<WebSearchTab />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Enable web search" }));
  expect(screen.getByLabelText("API key")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable webpage and PDF reading" }));
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByRole("checkbox", { name: "Enable web search" })).toBeChecked();
  expect(screen.getByLabelText("API key")).toBeInTheDocument();
});
it("removes only a credential without committing unrelated switch drafts", async () => {
  render(<WebSearchTab />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Enable web search" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove saved key" }));
  await waitFor(() => expect(writes).toEqual([{ api_keys: { brave: "" } }]));
  expect(screen.getByRole("checkbox", { name: "Enable web search" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});
