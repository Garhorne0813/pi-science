import i18n from "../../../i18n";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CitationInlineStyleSettings } from "./CitationInlineStyleSettings";
import { request } from "../../../lib/client/http";
vi.mock("../../../lib/client/http", () => ({ request: vi.fn(), responseError: (data: { error?: string }, fallback: string) => data.error ?? fallback }));

const mock = vi.mocked(request);
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { mock.mockReset(); });

const openMenu = () => {
  const trigger = screen.getByRole("button", { name: /^Inline citation style:/ });
  fireEvent.pointerDown(trigger); fireEvent.click(trigger);
  return trigger;
};

it("offers the two styles and saves the chosen one", async () => {
  const onSaved = vi.fn(async () => undefined);
  render(<CitationInlineStyleSettings style="number" onSaved={onSaved} />);
  const trigger = openMenu();
  expect(trigger).toHaveTextContent("Reference number");
  expect(screen.getByRole("menuitemradio", { name: /Reference number/ })).toBeInTheDocument();

  mock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, citation_inline_style: "identifier" })));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Identifier/ }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(mock).toHaveBeenCalledWith("/api/settings/citation-inline-style", expect.objectContaining({ method: "PUT", body: '{"style":"identifier"}' }));
});

it("keeps the saved style visible and shows the reason when saving fails", async () => {
  const onSaved = vi.fn(async () => undefined);
  render(<CitationInlineStyleSettings style="number" onSaved={onSaved} />);
  openMenu();
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "storage failed" }), { status: 503 }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Identifier/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("storage failed");
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /^Inline citation style:/ })).toHaveTextContent("Reference number");
});
