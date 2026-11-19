import i18n from "../../../i18n";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodemodeSettings } from "./CodemodeSettings";
import { settingsApi } from "../../../lib/settings";

vi.mock("../../../lib/settings", () => ({ settingsApi: { saveCodemode: vi.fn() } }));

const saveCodemode = vi.mocked(settingsApi.saveCodemode);
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { saveCodemode.mockReset(); });

it("saves the Codemode switch and refreshes runtime-backed settings", async () => {
  const onSaved = vi.fn(async () => undefined);
  render(<CodemodeSettings enabled={false} onSaved={onSaved} />);
  const toggle = screen.getByRole("switch", { name: "Codemode" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  saveCodemode.mockResolvedValueOnce({ ok: true, codemode_enabled: true });

  fireEvent.click(toggle);

  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(saveCodemode).toHaveBeenCalledWith(true);
});

it("keeps the saved position and displays server failures", async () => {
  render(<CodemodeSettings enabled={false} onSaved={vi.fn(async () => undefined)} />);
  saveCodemode.mockRejectedValueOnce(new Error("reload failed"));
  fireEvent.click(screen.getByRole("switch", { name: "Codemode" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("reload failed");
  expect(screen.getByRole("switch", { name: "Codemode" })).toHaveAttribute("aria-checked", "false");
});
