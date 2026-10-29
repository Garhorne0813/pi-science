import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { settingsSchema } from "@pi-science/contracts";
import { MemoryTab } from "./MemoryTab";
import { SettingsContent } from "./SettingsContent";
import i18n from "../../i18n";
let calls: Array<{ url: string; method: string; body: any }>;
let conflict: boolean;
let memoryEnabled: boolean;
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  calls = [];
  conflict = false;
  memoryEnabled = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input),
        method = init.method ?? "GET",
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const status = method === "PATCH" && conflict ? 409 : 200;
      return new Response(
        JSON.stringify(
          status === 409
            ? { error: "Settings revision changed" }
            : url.includes("/model-selection/catalog")
              ? {
                  available_models: [
                    { id: "configured/model", label: "Configured model" },
                  ],
                }
              : {
                  ...settingsSchema.parse({ enabled: memoryEnabled }),
                  revision: 4,
                },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    }),
  );
});
afterEach(() => { sessionStorage.clear();
  cleanup();
  vi.unstubAllGlobals();
});
function mount(ui = <MemoryTab />) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  );
}
it("edits global Memory policy with CAS, without requiring cwd or permitting science-review bypass", async () => {
  mount();
  const review = await screen.findByRole("button", {
    name: "Review mode: Smart review (recommended)",
  });
  fireEvent.pointerDown(review);
  fireEvent.click(review);
  fireEvent.click(
    await screen.findByRole("menuitemradio", {
      name: "Review everything manually",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("status");
  await waitFor(() =>
    expect(calls.some((c) => c.method === "PATCH")).toBe(true),
  );
  const change = calls.find((c) => c.method === "PATCH")!;
  expect(change.url).toBe("/api/memory/settings");
  expect(change.body).toMatchObject({
    expectedRevision: 4,
    settings: {
      review: { mode: "all_manual", scientificClaimsRequireHuman: true },
      dream: { updatePolicy: "suggest_only" },
    },
  });
  expect(calls.every((c) => !c.url.includes("cwd="))).toBe(true);
});
it("shows settings conflicts instead of a saved notice", async () => {
  mount();
  await screen.findByRole("button", {
    name: "Review mode: Smart review (recommended)",
  });
  conflict = true;
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow automatic recall" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Settings revision changed",
  );
  expect(screen.queryByText("Saved")).not.toBeInTheDocument();
});
it("is available in application Settings with global scope even when opened inside a project", async () => {
  const { container } = mount(
    <SettingsContent scope="project" initialTab="memory" />,
  );
  await screen.findByRole("button", {
    name: "Review mode: Smart review (recommended)",
  });
  expect(screen.getByRole("tab", { name: "Memory" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    within(container.querySelector("aside")!).getByText("Global settings"),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("Allow recall in this project"),
  ).not.toBeInTheDocument();
});

it("loads configured models during first-time setup before Memory has been saved as enabled", async () => {
  memoryEnabled = false;
  mount();
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Enable Memory" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Check increments after completed turns",
    }),
  );
  const model = screen.getByRole("button", {
    name: "Extraction model: Use default model",
  });
  fireEvent.pointerDown(model);
  fireEvent.click(model);
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Configured model" }),
  );
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      calls.find((c) => c.method === "PATCH")?.body.settings,
    ).toMatchObject({
      enabled: true,
      extraction: { enabled: true, model: "configured/model" },
    }),
  );
});
