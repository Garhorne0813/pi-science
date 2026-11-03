import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import i18n from "../../i18n";
import { MemoryBrowseControls } from "./MemoryBrowseControls";

// Draft-state tests use a native select; the browser UAT exercises real portal menus and focus handling.
vi.mock("../settings/SettingsSelectMenu", () => ({
  SettingsSelectMenu: ({
    ariaLabel,
    value,
    options,
    onSelect,
  }: {
    ariaLabel: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  }) => (
    <select
      aria-label={`${ariaLabel}: ${options.find((o) => o.value === value)?.label}`}
      value={value}
      onChange={(event) => onSelect(event.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
function mount() {
  const update = vi.fn();
  render(
    <MemoryBrowseControls
      filters={{
        status: "active",
        kind: "",
        scope: "",
        categoryId: "",
        sort: "updated_desc",
      }}
      categories={[{ id: "cat1", name: "Writing" }]}
      hasQuery={false}
      active
      update={update}
      clear={vi.fn()}
    />,
  );
  const open = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Filters and sorting" }),
    );
  return { update, open };
}
async function choose(dialog: HTMLElement, label: string, option: string) {
  const select = within(dialog).getByRole("combobox", {
    name: new RegExp("^" + label + ":"),
  }) as HTMLSelectElement;
  const value = Array.from(select.options).find(
    (o) => o.textContent === option,
  )!.value;
  fireEvent.change(select, { target: { value } });
}
it("keeps mobile choices as a draft and discards them on dismissal", async () => {
  const { update, open } = mount();
  open();
  const dialog = screen.getByRole("dialog", { name: "Filters and sorting" });
  await choose(dialog, "Status", "Archived");
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  open();
  expect(
    within(screen.getByRole("dialog")).getByRole("combobox", {
      name: "Status: Active",
    }),
  ).toBeInTheDocument();
  expect(update).not.toHaveBeenCalled();
});
it("applies multiple mobile choices in one update and resets only on Apply", async () => {
  const { update, open } = mount();
  open();
  let dialog = screen.getByRole("dialog");
  await choose(dialog, "Status", "Archived");
  await choose(dialog, "Category", "Writing");
  await choose(dialog, "Sort", "Recently created");
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Apply filters" }),
  );
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenLastCalledWith({
    status: "archived",
    kind: "",
    scope: "",
    categoryId: "cat1",
    sort: "created_desc",
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  open();
  dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(
    within(dialog).getByRole("combobox", { name: "Status: All" }),
  ).toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Apply filters" }),
  );
  expect(update).toHaveBeenLastCalledWith({
    status: "",
    kind: "",
    scope: "",
    categoryId: "",
    sort: "updated_desc",
  });
});
