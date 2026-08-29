import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { queryClient } from "../../lib/client/query-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let environments = [{
  environment_id: "env_test",
  revision_id: "rev_failed",
  display_name: "Failed environment",
  language: "python",
  status: "failed",
  packages: ["python=3.12"],
  failure: { message: "Python executable is missing" },
}];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (url === "/api/environments" && method === "GET") return jsonResponse({ environments });
  if (url === "/api/environments/rev_failed" && method === "DELETE") {
    environments = [];
    return jsonResponse({ ok: true, revision_id: "rev_failed" });
  }
  return jsonResponse({ error: `unhandled ${method} ${url}` }, 404);
});

beforeEach(() => {
  cleanup();
  queryClient.clear();
  environments = [{ environment_id: "env_test", revision_id: "rev_failed", display_name: "Failed environment", language: "python", status: "failed", packages: ["python=3.12"], failure: { message: "Python executable is missing" } }];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EnvironmentSettings", () => {
  it("deletes a failed environment revision", async () => {
    render(<QueryClientProvider client={queryClient}><EnvironmentSettings workspaceCwd={null} /></QueryClientProvider>);
    expect(await screen.findByText("Failed environment")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/environments/rev_failed", expect.objectContaining({ method: "DELETE" })));
    expect(await screen.findByText(/No shared environments yet/)).toBeInTheDocument();
  });
});
