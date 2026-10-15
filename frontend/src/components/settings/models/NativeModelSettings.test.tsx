import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NativeModelSettings } from "./NativeModelSettings";
import i18n from "../../../i18n";

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => vi.unstubAllGlobals());
const snapshot = { backend: "pi_ai_v1", revision: 3, config: { providers: { lab: { api: "openai-completions", baseUrl: "http://localhost:1234/v1", models: [{ id: "test" }] } } },
  schema_version: 1, credential_refs: { lab: "credential-id" }, keyless_providers: [], legacy_providers: [], aliases: {}, providers: [] };
function setup(conflict = false) {
  let readRevision = 3;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body });
    let status = 200;
    let data: unknown = { ok: true, runtime: "published" };
    if (url === "/api/model-config" && method === "GET") data = { ...snapshot, revision: readRevision };
    if (url === "/api/model-config/preview" && conflict) readRevision = 4;
    if (url === "/api/model-config/catalog") data = { revision: 3, providers: [{ id: "lab", name: "Lab", editable: true, legacy: false, config: snapshot.config.providers.lab,
      authentication: { source: "environment", resolved: true, environment_variable: "LAB_KEY", restart_required: true },
      models: [{ id: "test", name: "Test", available: true, contextWindow: 8192, source: "configured" }] }] };
    if (url === "/api/model-config" && method === "PUT" && conflict) { status = 409; data = { error: "Configuration changed; reload before saving" }; }
    if (url === "/api/model-config/discover") data = { models: [{ id: "candidate" }], inference_verified: false };
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
    fireEvent.click(screen.getByRole("button", { name: "Lab" }));
    expect(await screen.findByText("Selectable · Inference not verified")).toBeInTheDocument();
  });
  it("requires validation and keeps the editor draft after a revision conflict", async () => {
    const requests = setup(true);
    await screen.findByText(/Environment: LAB_KEY/);
    fireEvent.click(screen.getByRole("button", { name: "Advanced model configuration" }));
    const editor = screen.getByRole("textbox", { name: "Advanced model configuration" });
    const draft = JSON.stringify({ providers: { lab: { ...snapshot.config.providers.lab, name: "Draft" } } });
    fireEvent.change(editor, { target: { value: draft } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Validate configuration" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findAllByText("Configuration changed; reload before saving");
    expect(editor).toHaveValue(draft);
    expect(requests.find((request) => request.method === "PUT")?.body).toMatchObject({ revision: 3 });
  });
  it("does not commit discovered candidates until they are explicitly selected", async () => {
    const requests = setup();
    await screen.findByText(/Environment: LAB_KEY/);
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: "http://localhost:1234/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    expect(await screen.findByLabelText("candidate")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(requests.some((request) => request.url === "/api/model-config/providers")).toBe(false);
  });
});
