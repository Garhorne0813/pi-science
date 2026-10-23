import { useState } from "react";
import { beforeAll, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiscoveryList } from "./DiscoveryList";
import { type ModelConfigEdits } from "./model-utils";
import i18n from "../../../i18n";

beforeAll(async () => { await i18n.changeLanguage("en"); });
function List() {
  const [selected, setSelected] = useState(["chat"]), [edits, setEdits] = useState<Record<string, ModelConfigEdits>>({});
  return <DiscoveryList models={[{ id: "chat", kind: "chat", capabilities: { context_window: 8192 } }, { id: "embed", kind: "embedding" }, { id: "unknown" }]} selected={selected} onChange={setSelected} overrides={{ chat: { contextWindow: 128000 } }} edits={edits} onEdits={setEdits} />;
}
it("searches and filters model types without dropping selections outside the visible results", async () => {
  render(<List />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "embed" } });
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(screen.getByText("Found 3 · selected 2")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "" } });
  expect(screen.getByRole("checkbox", { name: /chat/i })).toBeChecked();
  fireEvent.pointerDown(screen.getByRole("button", { name: /^Model type:/ }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Embedding" }));
  expect(screen.queryByRole("checkbox", { name: /chat/i })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /embed/i })).toBeChecked();
});
it("shows saved corrections and restores a provider declaration on explicit reset", () => {
  render(<List />);
  expect(screen.getByLabelText("chat Context")).toHaveValue(128000);
  expect(screen.getByLabelText("chat Context")).toHaveAttribute("title", "User correction");
  fireEvent.click(screen.getByRole("button", { name: "chat Use provider values" }));
  expect(screen.getByLabelText("chat Context")).toHaveValue(8192);
  expect(screen.getByLabelText("chat Context")).toHaveAttribute("title", "Provider declaration");
  expect(screen.getByLabelText("unknown Context")).toHaveAttribute("title", "Runtime default; not provider-declared");
});
