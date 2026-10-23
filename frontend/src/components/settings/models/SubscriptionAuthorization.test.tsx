import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ModelOAuthSessionView } from "@pi-science/contracts";
import { SubscriptionAuthorization } from "./SubscriptionAuthorization";
import type { CatalogProvider } from "./native-model-api";
import i18n from "../../../i18n";

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => vi.unstubAllGlobals());
const provider: CatalogProvider = { id: "openai", name: "OpenAI", subscription_name: "OpenAI (ChatGPT subscription)", revision: 3, config: null, configured: false, legacy: false, editable: true, authentication: { source: "unconfigured", resolved: false }, source: "builtin", auth_capabilities: { api_key: true, environment: true, keyless: false, subscription: true }, allowed_actions: [], models: [] };
const pending: ModelOAuthSessionView = { id: "test-session", provider_id: "openai", status: "authorizing", expires_at: Date.now() + 600000, events: [{ type: "auth_url", url: "https://auth.openai.com/authorize?state=fixture" }, { type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }], prompt: { id: "00000000-0000-4000-8000-000000000001", type: "manual_code", message: "Paste callback URL" } };
function setup(options: { existing?: CatalogProvider; session?: ModelOAuthSessionView; failRefresh?: boolean } = {}) {
  let session = options.session ?? null;
  const requests: Array<{ url: string; method: string; body: unknown; keepalive?: boolean }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, body, keepalive: init.keepalive });
    if (url.endsWith("/current")) return Response.json({ session });
    if (url.endsWith("/start")) { session = pending; return Response.json(session); }
    if (url.endsWith("/respond")) { session = { ...pending, status: "succeeded", events: [], prompt: undefined }; return Response.json(session); }
    if (url.includes("/sessions/") && method === "DELETE") { session = { ...pending, status: "cancelled", events: [], prompt: undefined, error_code: "oauth_cancelled" }; return Response.json(session); }
    if (url.endsWith("/refresh") && options.failRefresh) return Response.json({ error: "Refresh failed" }, { status: 400 });
    return Response.json({ ok: true });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), onSaved = vi.fn().mockResolvedValue(undefined), onFailure = vi.fn().mockResolvedValue(undefined);
  const view = render(<QueryClientProvider client={client}><SubscriptionAuthorization provider={options.existing ?? provider} revision={3} onSaved={onSaved} onFailure={onFailure} /></QueryClientProvider>);
  return { requests, onSaved, onFailure, client, ...view };
}
it("uses subscription-only fields and completes a provider prompt without persisting the submitted callback", async () => {
  const { requests, onSaved } = setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "Start authorization" })).not.toBeDisabled());
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
  expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "Open official authorization page" })[0]).toHaveAttribute("href", "https://auth.openai.com/authorize?state=fixture");
  fireEvent.change(screen.getByLabelText("Paste callback URL"), { target: { value: "http://localhost/callback?code=private-code" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(requests.find((r) => r.url.endsWith("/respond"))?.body).toMatchObject({ prompt_id: pending.prompt!.id, value: "http://localhost/callback?code=private-code" });
  expect(screen.queryByDisplayValue(/private-code/)).not.toBeInTheDocument();
  expect(JSON.stringify(localStorage)).not.toContain("private-code");
});
it("requires explicit confirmation before replacing a provider's API connection", async () => {
  const { requests } = setup({ existing: { ...provider, configured: true, authentication: { source: "managed", resolved: true } } });
  await screen.findByRole("checkbox");
  expect(screen.getByRole("button", { name: "Start authorization" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Start authorization" }));
  await screen.findByText("ABCD-1234"); expect(requests.find((r) => r.url.endsWith("/start"))?.body).toEqual({ revision: 3, replace_existing: true });
});
it("restores an active server-side session and cancels it when the step is closed", async () => {
  const { requests, unmount } = setup({ session: pending });
  await screen.findByText("ABCD-1234"); expect(requests.some((r) => r.url.endsWith("/start"))).toBe(false);
  unmount(); await waitFor(() => expect(requests.find((r) => r.method === "DELETE")).toMatchObject({ url: "/api/model-config/oauth/sessions/test-session", keepalive: true }));
});
it("shows cancellation without presenting it as a completed authorization", async () => {
  const { onSaved } = setup({ session: pending }); await screen.findByText("ABCD-1234");
  fireEvent.click(screen.getByRole("button", { name: "Cancel authorization" }));
  expect(await screen.findByText("Authorization cancelled.")).toBeInTheDocument(); expect(onSaved).not.toHaveBeenCalled();
});
it("keeps a failed refresh visible, and confirms local authorization removal", async () => {
  const { requests, onSaved } = setup({ existing: { ...provider, configured: true, authentication: { source: "oauth", resolved: false, oauth: { status: "expired", expires_at: Date.now() - 1000, account: null, plan: null } } }, failRefresh: true });
  fireEvent.click(await screen.findByRole("button", { name: "Refresh authorization" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Refresh failed"); expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect authorization" }));
  expect(screen.getByText(/provider-side grant/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Disconnect authorization" })[1]);
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(requests.find((r) => r.method === "DELETE")?.body).toEqual({ revision: 3 });
});

it("requires replacement confirmation for a broken credential reference", async () => {
  setup({ existing: { ...provider, configured: true, authentication: { source: "unconfigured", resolved: false, configured: true } } });
  await screen.findByRole("checkbox"); expect(screen.getByRole("button", { name: "Start authorization" })).toBeDisabled();
});
