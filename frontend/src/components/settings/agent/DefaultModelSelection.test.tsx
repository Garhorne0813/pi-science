import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DefaultModelSelection } from "./DefaultModelSelection";
import { modelSelectionApi, modelSelectionKeys } from "../../../lib/model-selection";
import { queryClient } from "../../../lib/client/query-client";
import i18n from "../../../i18n";
const models = ["flash", "pro"].map((name) => ({ id: `deepseek/${name}`, provider: "deepseek", model: name, label: name, custom: false, capability_source: "fixture", reasoning: true, thinking_levels: ["off", "high"] }));
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => {
  queryClient.clear();
  vi.spyOn(modelSelectionApi, "readDefault").mockResolvedValue({ scope: "default", selection: { model: "deepseek/flash", thinking: "off" } });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
async function select(name: string, option: string) {
  const trigger = screen.getByRole("button", { name: new RegExp(`^${name}:`) });
  fireEvent.pointerDown(trigger); fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: option }));
}
describe("default model selection", () => {
  it("saves an explicit draft and retains it after a failed save for retry", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("disk unavailable")).mockImplementation(async (selection) => {
      queryClient.setQueryData(modelSelectionKeys.default, { scope: "default", selection });
    });
    render(<DefaultModelSelection models={models} saving={false} onSave={onSave} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Default model: flash" })).toBeEnabled());
    await select("Default model", "pro");
    await select("Thinking Level", "High");
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk unavailable");
    expect(screen.getByRole("button", { name: "Default model: pro" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave).toHaveBeenLastCalledWith({ model: "deepseek/pro", thinking: "high" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });
  it("clears the default only after Save", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<DefaultModelSelection models={models} saving={false} onSave={onSave} />);
    const clear = await screen.findByRole("button", { name: "Clear default model" });
    await waitFor(() => expect(clear).toBeEnabled());
    fireEvent.click(clear);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ model: null, thinking: "off" }));
  });
  it("bounds a large default-model menu while keeping searched models reachable", async () => {
    const catalog = Array.from({ length: 10000 }, (_, index) => ({ ...models[0]!, id: `lab/model-${index}`, label: `Model ${index}` }));
    render(<DefaultModelSelection models={catalog} saving={false} onSave={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /^Default model:/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.pointerDown(trigger); fireEvent.click(trigger);
    expect(await screen.findAllByRole("menuitemradio")).toHaveLength(50);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Model 9999" } });
    expect(await screen.findAllByRole("menuitemradio")).toHaveLength(1);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Model 9999" }));
    expect(screen.getByRole("button", { name: "Default model: Model 9999" })).toBeVisible();
  });

});
