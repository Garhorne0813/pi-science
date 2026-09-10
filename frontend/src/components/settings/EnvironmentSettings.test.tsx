import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EnvironmentSettings } from "./EnvironmentSettings";

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
  environments = [{ environment_id: "env_test", revision_id: "rev_failed", display_name: "Failed environment", language: "python", status: "failed", packages: ["python=3.12"], failure: { message: "Python executable is missing" } }];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EnvironmentSettings", () => {
  it("deletes a failed environment revision", async () => {
    render(<EnvironmentSettings workspaceCwd={null} />);
    expect(await screen.findByText("Failed environment")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/environments/rev_failed", expect.objectContaining({ method: "DELETE" })));
    expect(await screen.findByText(/No shared environments yet/)).toBeInTheDocument();
  });

  it("ignores a stale binding response after switching workspaces", async () => {
    environments = [{ ...environments[0], status: "ready", revision_id: "rev_a" }];
    let resolveFirst!: (response: Response) => void;
    const firstBinding = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/environments") return jsonResponse({ environments });
      if (url.includes("cwd=workspace-a")) return firstBinding;
      if (url.includes("cwd=workspace-b")) return jsonResponse({ revision_id: "rev_b", ready: true });
      return jsonResponse({ error: `unhandled ${init?.method ?? "GET"} ${url}` }, 404);
    });

    const { rerender } = render(<EnvironmentSettings workspaceCwd="workspace-a" />);
    rerender(<EnvironmentSettings workspaceCwd="workspace-b" />);
    resolveFirst(jsonResponse({ revision_id: "rev_failed", ready: true }));

    expect(await screen.findByText("Use")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });
});
