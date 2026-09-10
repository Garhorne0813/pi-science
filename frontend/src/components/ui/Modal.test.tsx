import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import { Modal } from "./Modal";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open modal</button>
      {open && <Modal title="Nested settings" onClose={() => setOpen(false)}><button type="button">Action</button></Modal>}
    </>
  );
}

describe("Modal", () => {
  it("traps focus, makes the background inert, and restores focus on Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open modal" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Nested settings" });
    expect(dialog).toHaveFocus();
    expect(trigger.closest("div")).toHaveAttribute("inert");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nested settings" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(trigger.closest("div")).not.toHaveAttribute("inert");
  });
});
