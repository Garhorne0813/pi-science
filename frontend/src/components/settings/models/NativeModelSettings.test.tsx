import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Configuration } from "./native-model-api";
import { NativeModelSettings } from "./NativeModelSettings";
import i18n from "../../../i18n";

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => vi.unstubAllGlobals());
const snapshot = { backend: "pi_ai_v1", revision: 3, config: { providers: { lab: { api: "openai-completions", baseUrl: "http://localhost:1234/v1", models: [{ id: "test", contextWindow: 8192, reasoning: true, discoveredFields: ["contextWindow", "reasoning"] }], headers: { "accept": "application/json" } } } },
  schema_version: 1, credential_refs: { lab: "credential-id" }, keyless_providers: [], legacy_providers: [], aliases: {}, providers: [] };
function setup(conflict = false, unresolved = false, mergeable = false, pendingRuntime = false, scenario = "normal") {
  let readRevision = 3, failedCalls = 0;
  const state: Configuration = JSON.parse(JSON.stringify(snapshot));
  if (scenario === "untracked") delete state.config.providers.lab!.models![0]!.discoveredFields;
  if (["partial", "partial-many", "conflict"].includes(scenario)) state.config.providers.broken = structuredClone(state.config.providers.lab!);
  if (scenario === "partial-many") state.config.providers.broken2 = structuredClone(state.config.providers.lab!);
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body });
    let status = 200;
    let data: unknown = { ok: true, runtime: "published" };
    if (url === "/api/model-config" && method === "GET") data = { ...state, revision: readRevision };
    if (url === "/api/model-config/preview" && conflict) readRevision = 4;
    if (url === "/api/model-config/catalog") data = { revision: 3, providers: [{ id: "lab", name: "Lab", editable: true, legacy: false, revision: 3, configured: true, source: "user", auth_capabilities: { api_key: true, environment: true, keyless: true, subscription: false }, allowed_actions: ["details", "credential", "edit", "disconnect", ...(mergeable ? ["refresh"] : [])], config: state.config.providers.lab,
      authentication: { source: "environment", resolved: !unresolved, environment_variable: "LAB_KEY", restart_required: true },
      models: [{ id: "test", name: "Test", available: !unresolved, contextWindow: 8192, source: "configured" }] }, { id: "untouched", name: "Untouched", configured: false, source: "builtin", editable: true, revision: 3, legacy: false, config: null, authentication: { source: "unconfigured", resolved: false }, auth_capabilities: { api_key: true, environment: true, keyless: false, subscription: false }, allowed_actions: ["credential", "details", "disconnect"], models: [] }] };
    if (url === "/api/model-config/catalog" && (["partial", "partial-many", "conflict"].includes(scenario))) (data as { providers: unknown[] }).providers.push({ ...((data as { providers: Record<string, unknown>[] }).providers[0]), id: "broken", name: "Broken", config: state.config.providers.broken });
    if (url === "/api/model-config/catalog" && scenario === "partial-many") (data as { providers: unknown[] }).providers.push({ ...((data as { providers: Record<string, unknown>[] }).providers[0]), id: "broken2", name: "Still broken", config: state.config.providers.broken2 });
    if (url === "/api/model-config/providers/broken2/discover") { status = 400; data = { code: "discovery_auth" }; }
    if (url === "/api/model-config/providers/broken/discover") {
      failedCalls += 1;
      if (failedCalls === 1) { status = 400; data = { code: "discovery_auth", error: "do-not-echo-key" }; }
      else data = { models: [{ id: "test", capabilities: { context_window: 8192, reasoning: true } }] };
    }
    if (url === "/api/model-config/providers/lab" && method === "PATCH") {
      if (scenario === "conflict") { status = 409; data = { code: "revision_conflict", error: "Configuration changed" }; }
      else { state.config.providers.lab = body.config; readRevision += 1; data = { ok: true, revision: readRevision, runtime: pendingRuntime ? "reload_pending" : "published" }; }
    }
    if ((url === "/api/model-config" && method === "PUT" || url === "/api/model-config/providers" && method === "POST") && conflict) { status = 409; data = { error: "Configuration changed; reload before saving" }; }
    if (url === "/api/model-config/providers/lab" && method === "PATCH" && pendingRuntime) data = { ok: true, revision: readRevision, runtime: "reload_pending" };
    if (url === "/api/model-config/discover") data = { models: [{ id: "candidate", kind: "chat" }], inference_verified: false };
    if (url === "/api/model-config/providers/lab/discover") data = { models: [{ id: "test", display_name: "Test", capabilities: { context_window: 1000000, max_output_tokens: 65536, reasoning: true } }, { id: "new-model", display_name: "New Model", kind: "chat" }] };
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NativeModelSettings /></QueryClientProvider>);
  return requests;
}

describe("native model Settings", () => {
  it("shows explicit environment source and restart/inference boundaries", async () => {
    setup();
    expect(await screen.findByText(/Environment: LAB_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/Worker reload does not reload OS variables/)).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("settings.native.capabilitySource"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    expect(screen.getByText(i18n.t("settings.native.capabilitySource"))).toBeInTheDocument();
    expect(await screen.findByRole("columnheader", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "8K" })).toBeInTheDocument();
    expect(screen.queryByText(/Inference not verified/)).not.toBeInTheDocument();
  });
  it("states availability only for models that are actually unavailable", async () => {
    setup(false, true);
    fireEvent.click(await screen.findByRole("button", { name: "Lab" }));
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("0 / 1 available")).toBeInTheDocument();
  });
  it("rewrites capabilities on existing models and appends new ones during a refresh", async () => {
    const requests = setup(false, false, true);
    await screen.findByRole("button", { name: "Lab" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText("Refreshed · 1 added · 1 updated Live now; new turns use the updated models.")).toBeInTheDocument();
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ revision: 3, config: { models: [
      { id: "test", contextWindow: 1000000, maxTokens: 65536, reasoning: true },
      { id: "new-model", name: "New Model" },
    ] } });
  });
  it("reports a pending runtime reload after a refresh", async () => {
    setup(false, false, true, true);
    await screen.findByRole("button", { name: "Lab" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText("Refreshed · 1 added · 1 updated Runtime reload pending; active turns keep their configuration.")).toBeInTheDocument();
  });
  it("re-reads the catalog on demand", async () => {
    const requests = setup();
    await screen.findByRole("button", { name: "Lab" });
    const before = requests.filter((request) => request.url === "/api/model-config/catalog").length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    expect(await screen.findByText("Model list refreshed.")).toBeInTheDocument();
    expect(requests.filter((request) => request.url === "/api/model-config/catalog").length).toBeGreaterThan(before);
  });
});

async function openMenu() {
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Lab actions" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}
it("shows only configured services, starts collapsed, and exposes credentials solely in the menu", async () => {
  setup();
  expect(await screen.findByRole("button", { name: "Lab" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Untouched" })).not.toBeInTheDocument();
  expect(screen.queryByText("Manage credentials")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Lab" }));
  expect(screen.queryByText("Manage credentials")).not.toBeInTheDocument();
  await openMenu();
  expect(await screen.findByRole("menuitem", { name: "Manage credentials" })).toBeInTheDocument();
});
it("keeps the custom API entry visible for empty searches and discards sensitive drafts before changing tabs", async () => {
  setup(); await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search providers" }), { target: { value: "no match" } });
  expect(screen.getByRole("button", { name: "Custom API" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "Search providers" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: /Untouched/ }));
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "unsaved-secret" } });
  fireEvent.click(screen.getByRole("tab", { name: "Subscription" }));
  expect(screen.getByRole("tab", { name: "API" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.getByText("Subscription authorization is not available yet")).toBeInTheDocument();
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "API" }));
  expect(screen.getByLabelText("API key")).toHaveValue("");
});
it("saves the capability edits entered on a discovered model", async () => {
  const requests = setup(); await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
  fireEvent.click(screen.getByRole("button", { name: "Custom API" }));
  for (const [label, value] of [["Provider name", "Edited Lab"], ["API key", "edit-secret"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "http://localhost:1234/v1" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection and discover" }));
  fireEvent.change(await screen.findByLabelText("candidate Context", {}, { timeout: 3000 }), { target: { value: "200000" } });
  fireEvent.click(screen.getByRole("switch", { name: "candidate Thinking" }));
  fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(requests.find((request) => request.url === "/api/model-config/providers")?.body).toMatchObject({ config: { models: [{ id: "candidate" }], modelOverrides: { candidate: { contextWindow: 200000, reasoning: true, thinkingLevelMap: { xhigh: "high", max: "high" } } } } });
});
it("retains a custom API draft after conflict and never retries the sensitive write", async () => {
  const requests = setup(true); await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
  fireEvent.click(screen.getByRole("button", { name: "Custom API" }));
  for (const [label, value] of [["Provider name", "New Lab"], ["API key", "retained-secret"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "http://localhost:1234/v1" } });
  fireEvent.change(screen.getByLabelText(/Manual model IDs/), { target: { value: "manual-model" } });
  fireEvent.submit(screen.getByLabelText("API key").closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("Configuration changed");
  expect(screen.getByLabelText("API key")).toHaveValue("retained-secret");
  const writes = requests.filter((r) => r.url === "/api/model-config/providers");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toHaveProperty("id", expect.stringMatching(/^custom-[0-9a-f-]{36}$/));
  expect(screen.queryByLabelText("Provider ID")).not.toBeInTheDocument();
  expect(writes[0].body).toMatchObject({ revision: 3, credential: { source: "managed", secret: "retained-secret" }, config: { models: [{ id: "manual-model" }] } });
});
it("edits a custom connection while preserving model metadata and headers", async () => {
  const requests = setup(); await openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit connection" }));
  const dialog = screen.getByRole("dialog", { name: "Lab · Edit connection" });
  fireEvent.change(within(dialog).getByLabelText("Provider name"), { target: { value: "Renamed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(requests.find((r) => r.method === "PATCH")?.body).toMatchObject({ revision: 3, config: { name: "Renamed", models: [{ id: "test", contextWindow: 8192, reasoning: true }], headers: { accept: "application/json" } } });
});

it("retains configured connections whose credentials no longer resolve", async () => {
  setup(false, true);
  expect(await screen.findByRole("button", { name: "Lab" })).toBeInTheDocument();
  expect(screen.getByText("Needs attention")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Untouched" })).not.toBeInTheDocument();
});

it("does not PATCH or publish configuration on a second identical refresh", async () => {
  const requests = setup(false, false, true);
  await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText(/1 added · 1 updated/);
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("Model list refreshed.");
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
});
it("requires a source decision before changing old values and can keep them as persistent overrides", async () => {
  const requests = setup(false, false, true, false, "untracked");
  await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
  fireEvent.click(await screen.findByLabelText("Keep existing values as user corrections"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({ config: { modelOverrides: { test: { contextWindow: 8192 } } } });
});
it("reports partial success and retries only the failing service without exposing payloads", async () => {
  const requests = setup(false, false, true, false, "partial");
  await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  expect(await screen.findByText(/Partially refreshed/)).toHaveTextContent("1 services need attention");
  expect(screen.queryByText(/do-not-echo-key/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry this service" }));
  await waitFor(() => expect(requests.filter((request) => request.url.endsWith("broken/discover"))).toHaveLength(2));
  expect(requests.filter((request) => request.url.endsWith("lab/discover"))).toHaveLength(1);
});
it("stops refreshing after a revision conflict without automatically retrying a write", async () => {
  const requests = setup(false, false, true, false, "conflict");
  await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText(/No changes published/);
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  expect(requests.filter((request) => request.url.endsWith("broken/discover"))).toHaveLength(0);
});

it("retains other failures after one targeted retry succeeds", async () => {
  setup(false, false, true, false, "partial-many");
  await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  expect(await screen.findByText(/Partially refreshed/)).toHaveTextContent("2 services need attention");
  fireEvent.click(screen.getAllByRole("button", { name: "Retry this service" })[0]!);
  expect(await screen.findByText(/No changes published/)).toHaveTextContent("1 services need attention");
  expect(screen.getByRole("alert")).toHaveTextContent("Still broken");
});
it("reports unresolved credentials without attempting a discovery request", async () => {
  const requests = setup(false, true, true);
  await screen.findByRole("button", { name: "Lab" });
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText(/No changes published/);
  expect(screen.getByRole("alert")).toHaveTextContent("Authentication rejected");
  expect(requests.filter((request) => request.url.endsWith("/discover"))).toHaveLength(0);
});
