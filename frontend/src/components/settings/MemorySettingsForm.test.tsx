import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { settingsSchema } from "@pi-science/contracts";
import { MemorySettingsForm } from "./MemorySettingsForm";
import i18n from "../../i18n";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
function mount(enabled = true) {
  const save = vi.fn(async () => true);
  render(
    <MemorySettingsForm
      value={{ ...settingsSchema.parse({ enabled }), revision: 1 }}
      busy={false}
      save={save}
    />,
  );
  return save;
}
const toggle = (name: string) =>
  fireEvent.click(screen.getByRole("checkbox", { name }));
async function mode(name: string) {
  const button = screen.getByRole("button", { name: /^Trigger mode:/ });
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name }),
  );
}
it("collapses Memory and extraction options without losing edited values on save", () => {
  const save = mount(false);
  expect(
    screen.queryByRole("checkbox", {
      name: "Check increments after completed turns",
    }),
  ).not.toBeInTheDocument();
  toggle("Enable Memory");
  expect(
    screen.queryByRole("textbox", { name: "Extraction model" }),
  ).not.toBeInTheDocument();
  toggle("Check increments after completed turns");
  fireEvent.change(screen.getByRole("textbox", { name: "Extraction model" }), {
    target: { value: "configured/model" },
  });
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Minimum new messages" }),
    { target: { value: "8" } },
  );
  toggle("Check increments after completed turns");
  expect(
    screen.queryByRole("textbox", { name: "Extraction model" }),
  ).not.toBeInTheDocument();
  toggle("Check increments after completed turns");
  expect(screen.getByRole("textbox", { name: "Extraction model" })).toHaveValue(
    "configured/model",
  );
  toggle("Enable Memory");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: false,
      extraction: expect.objectContaining({
        enabled: true,
        model: "configured/model",
        minMessages: 8,
      }),
    }),
  );
});
it("shows Dream scheduling controls according to trigger mode and idle requirement", async () => {
  mount();
  expect(
    screen.queryByRole("button", { name: /^Trigger mode:/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("spinbutton", { name: "Maximum runtime (minutes)" }),
  ).not.toBeInTheDocument();
  toggle("Enable Dream");
  expect(
    screen.getByRole("spinbutton", { name: "Cooldown (hours)" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("spinbutton", { name: "Trigger interval (hours)" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", {
      name: "At most one automatic run per window",
    }),
  ).not.toBeInTheDocument();
  toggle("Require idle");
  expect(
    screen.queryByRole("spinbutton", { name: "Idle minutes" }),
  ).not.toBeInTheDocument();
  await mode("Interval");
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Trigger interval (hours)" }),
    { target: { value: "48" } },
  );
  expect(
    screen.getByRole("checkbox", {
      name: "At most one automatic run per window",
    }),
  ).toBeInTheDocument();
  await mode("Idle");
  expect(
    screen.queryByRole("spinbutton", { name: "Trigger interval (hours)" }),
  ).not.toBeInTheDocument();
  toggle("Require idle");
  expect(
    screen.getByRole("spinbutton", { name: "Idle minutes" }),
  ).toBeInTheDocument();
  await mode("Time window");
  expect(screen.getByLabelText("Start")).toBeInTheDocument();
  await mode("Interval");
  expect(
    screen.getByRole("spinbutton", { name: "Trigger interval (hours)" }),
  ).toHaveValue(48);
  toggle("Enable Dream");
  expect(screen.queryByLabelText("Start")).not.toBeInTheDocument();
  toggle("Enable Dream");
  expect(
    screen.getByRole("spinbutton", { name: "Trigger interval (hours)" }),
  ).toHaveValue(48);
});
it("preserves time-window values while its restriction is collapsed", () => {
  const save = mount();
  toggle("Enable Dream");
  fireEvent.change(screen.getByLabelText("Start"), {
    target: { value: "02:30" },
  });
  toggle("Restrict allowed execution window");
  expect(screen.queryByLabelText("Start")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("IANA time zone")).not.toBeInTheDocument();
  toggle("Restrict allowed execution window");
  expect(screen.getByLabelText("Start")).toHaveValue("02:30");
  toggle("Restrict allowed execution window");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      dream: expect.objectContaining({
        allowedWindow: expect.objectContaining({
          enabled: false,
          start: "02:30",
        }),
      }),
    }),
  );
});
