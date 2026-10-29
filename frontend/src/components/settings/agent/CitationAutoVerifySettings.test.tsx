import i18n from "../../../i18n";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CitationAutoVerifySettings } from "./CitationAutoVerifySettings";
import { request } from "../../../lib/client/http";
vi.mock("../../../lib/client/http", () => ({ request: vi.fn(), responseError: (data: { error?: string }, fallback: string) => data.error ?? fallback }));

const mock = vi.mocked(request);
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { mock.mockReset(); });

it("writes the switch to the server and asks the caller to reload", async () => {
  const onSaved = vi.fn(async () => undefined);
  render(<CitationAutoVerifySettings enabled={false} onSaved={onSaved} />);
  const toggle = screen.getByRole("switch", { name: "Citation verification" });
  expect(toggle).toHaveAttribute("aria-checked", "false");

  mock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, citation_auto_verify: true })));
  fireEvent.click(toggle);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(mock).toHaveBeenCalledWith("/api/settings/citation-auto-verify", expect.objectContaining({ method: "PUT", body: '{"enabled":true}' }));
});

it("keeps the switch position and shows the reason when saving fails", async () => {
  const onSaved = vi.fn(async () => undefined);
  render(<CitationAutoVerifySettings enabled={false} onSaved={onSaved} />);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "storage failed" }), { status: 503 }));
  fireEvent.click(screen.getByRole("switch", { name: "Citation verification" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("storage failed");
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByRole("switch", { name: "Citation verification" })).toHaveAttribute("aria-checked", "false");
});
