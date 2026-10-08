import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../client/query-client";
import { skillsMutations } from "./skills-mutations";

/** The catalogue the composer reads for one workspace and session. */
const catalogueKey = ["slash-commands", "/tmp/lab", "session-1"];

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
    queryClient.setQueryData(catalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    await skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" });
    expect(queryClient.getQueryState(catalogueKey)?.isInvalidated).toBe(true);
  });

  it("leaves the catalogue alone when the write fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "skills are read-only" }, 500)));
    queryClient.setQueryData(catalogueKey, [{ name: "skill:review", description: "Review files", group: "skill" }]);
    await expect(skillsMutations.create("/tmp/lab", { name: "review", description: "Review files" })).rejects.toThrow("skills are read-only");
    expect(queryClient.getQueryState(catalogueKey)?.isInvalidated).toBe(false);
  });
});
