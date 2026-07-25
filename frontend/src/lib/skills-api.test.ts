import { afterEach, describe, expect, it, vi } from "vitest";
import { skillsApi } from "./skills-api";

afterEach(() => vi.unstubAllGlobals());

describe("skills capability", () => {
  it("does not request project skills without a workspace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(skillsApi.list()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scopes project skill discovery to the workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await skillsApi.list("/tmp/lab");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/skills?cwd=%2Ftmp%2Flab");
  });
});
