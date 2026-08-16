import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../lib/client/query-client";
import i18n from "../../i18n";
import { SkillsTab } from "./SkillsTab";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const calls: Array<{ url: string; method: string; body?: unknown }> = [];

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (url === "/api/settings/skills" || url.startsWith("/api/settings/skills?cwd=")) {
    return Promise.resolve(jsonResponse({
      skills: [
        { skill_id: "builtin-1", name: "alpha", description: "Builtin alpha", source: "builtin", enabled: true, validation: { valid: true } },
        { skill_id: "project-1", name: "beta", description: "Project beta", source: "project", enabled: true, validation: { valid: true } },
      ],
      configured: false,
    }));
  }
  if (url.startsWith("/api/settings/skills?cwd=") && method === "POST") {
    return Promise.resolve(jsonResponse({ ok: true, skill: { name: "new-skill", source: "project" } }));
  }
  if (url.startsWith("/api/settings/skills/project-1?cwd=") && method === "DELETE") {
    return Promise.resolve(jsonResponse({ ok: true, name: "beta" }));
  }
  if (url.startsWith("/api/settings/skills/project-1?cwd=") && method === "PUT") {
    return Promise.resolve(jsonResponse({ ok: true, skill: { name: "beta", source: "project" } }));
  }
  if (url.startsWith("/api/skills/project-1/content?cwd=")) {
    return Promise.resolve(jsonResponse({ content: "# Beta\n\nBody" }));
  }
  return Promise.resolve(jsonResponse({ error: `unhandled ${method} ${url}` }, 404));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => defaultFetch(String(input), init));

function renderTab(cwd: string | null) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsTab workspaceCwd={cwd} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  cleanup();
  fetchMock.mockClear();
  calls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SkillsTab", () => {
  it("lists skills and marks project skills with a badge", async () => {
    renderTab("/tmp/ws");
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(await screen.findByText("beta")).toBeInTheDocument();
    expect(screen.getAllByText("project")).toHaveLength(1);
    expect(screen.getAllByText("builtin")).toHaveLength(1);
  });

  it("shows Add skill only for a workspace scope", async () => {
    renderTab(null);
    await screen.findByText("alpha");
    expect(screen.queryByRole("button", { name: "Add skill" })).not.toBeInTheDocument();
    cleanup();
    renderTab("/tmp/ws");
    expect(await screen.findByRole("button", { name: "Add skill" })).toBeInTheDocument();
  });

  it("creates a project skill from the Add skill menu", async () => {
    renderTab("/tmp/ws");
    const add = await screen.findByRole("button", { name: "Add skill" });
    fireEvent.pointerDown(add);
    fireEvent.click(add);
    const write = await screen.findByText("Write from scratch");
    fireEvent.click(write);
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "new-skill" } });
    const description = screen.getByLabelText("Description");
    fireEvent.change(description, { target: { value: "New project skill" } });
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.startsWith("/api/settings/skills?cwd=") && (call.body as { name?: string } | undefined)?.name === "new-skill")).toBe(true);
    });
  });

  it("deletes a project skill after confirmation", async () => {
    renderTab("/tmp/ws");
    await screen.findByText("beta");
    const deleteButton = screen.getByRole("button", { name: "Delete beta" });
    fireEvent.click(deleteButton);
    const confirm = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/api/settings/skills/project-1"))).toBe(true);
    });
  });

  it("opens the editor for a project skill", async () => {
    renderTab("/tmp/ws");
    await screen.findByText("beta");
    fireEvent.click(screen.getByRole("button", { name: "Edit beta" }));
    expect(await screen.findByRole("dialog", { name: "Edit project skill" })).toBeInTheDocument();
  });
});