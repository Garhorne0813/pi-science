import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { queryClient } from "../client/query-client";
import { slashCommandsKey, slashCommandsQuery } from "../conversation/slash-commands";
import { skillsMutations } from "./skills-mutations";

/** Workspace writes invalidate both the blank-composer catalog and active-session catalogs. */
const workspaceCatalogueKey = slashCommandsKey("/tmp/lab", null);
const sessionCatalogueKey = slashCommandsKey("/tmp/lab", "session-1");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("skill writes refresh the command catalogue", () => {
  it("marks the workspace catalogue stale after a successful write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true, skill: { name: "review" } })));
    queryClient.setQueryData(workspaceCatalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    queryClient.setQueryData(sessionCatalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    await skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" });
    expect(queryClient.getQueryState(workspaceCatalogueKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sessionCatalogueKey)?.isInvalidated).toBe(true);
  });

  it("leaves the catalogue alone when the write fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "skills are read-only" }, 500)));
    queryClient.setQueryData(workspaceCatalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    await expect(skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" })).rejects.toThrow("skills are read-only");
    expect(queryClient.getQueryState(workspaceCatalogueKey)?.isInvalidated).toBe(false);
  });
});

describe("a mounted composer catalogue", () => {
  it("refetches after a skill write reaches the catalogue prefix", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/commands?")
      ? jsonResponse({ commands: [] })
      : jsonResponse({ ok: true, skill: { name: "review" } }));
    vi.stubGlobal("fetch", fetch);
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    const catalogueReads = () => fetch.mock.calls.filter((call) => String(call[0]).includes("/commands?")).length;
    const { result, unmount } = renderHook(() => useQuery(slashCommandsQuery("/tmp/lab")), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const before = catalogueReads();

    await skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" });

    await waitFor(() => expect(catalogueReads()).toBeGreaterThan(before));
    unmount();
  });
});

