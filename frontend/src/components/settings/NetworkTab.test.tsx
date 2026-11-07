import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { NetworkTab } from "./NetworkTab";
let rules: Array<{ profile: string; domain: string; decision: string }>;
let revision: number;
const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
beforeEach(async () => {
  await i18n.changeLanguage("en"); rules = []; revision = 0; requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = JSON.parse(String(init?.body)); requests.push({ method, body });
      rules = rules.filter((rule) => rule.domain !== body.domain || rule.profile !== body.profile);
      if (method === "POST") rules.push(body); revision++;
    }
    return new Response(JSON.stringify({ revision, rules, profiles: { analysis: { allowedDomains: [], deniedDomains: ["pastebin.com"] }, mcp: { allowedDomains: [], deniedDomains: [] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(["api.example.org", "192.168.1.10:8080"])("adds and revokes a permission for %s", async (domain) => {
  render(<NetworkTab />);
  await screen.findByText("No domain permissions have been added.");
  expect(screen.getByText(/Tunnels can carry raw TCP; the proxy does not verify a TLS handshake/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Hostname or private IPv4 address"), { target: { value: domain } });
  const profile = screen.getByRole("button", { name: /^Applies to:/ });
  fireEvent.pointerDown(profile); fireEvent.click(profile);
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Local MCP" }));
  fireEvent.click(screen.getByRole("button", { name: "Save permission" }));
  await screen.findByText(domain);
  expect(requests[0]).toEqual({ method: "POST", body: { profile: "mcp", domain, decision: "allow" } });
  await waitFor(() => expect(screen.getByRole("button", { name: `Remove ${domain}` })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: `Remove ${domain}` }));
  await screen.findByText("No domain permissions have been added.");
  expect(requests[1]).toEqual({ method: "DELETE", body: { profile: "mcp", domain } });
});
it("shows server validation errors without losing the user's input", async () => {
  render(<NetworkTab />); await screen.findByText("No domain permissions have been added.");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Domain is blocked by the operator network policy" }), { status: 400, headers: { "Content-Type": "application/json" } })));
  fireEvent.change(screen.getByLabelText("Hostname or private IPv4 address"), { target: { value: "pastebin.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save permission" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Domain is blocked");
  expect(screen.getByLabelText("Hostname or private IPv4 address")).toHaveValue("pastebin.com");
});
