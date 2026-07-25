import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, invalidateApiCache } from "./api";

afterEach(() => {
  invalidateApiCache();
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("surfaces the backend error message for failed JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Workspace access denied" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )));

    await expect(apiRequest("/api/example", { retries: 0 })).rejects.toMatchObject({
      message: "Workspace access denied",
      status: 403,
    });
  });

  it("shares identical in-flight GET requests", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const first = apiRequest<{ ok: boolean }>("/api/skills", { retries: 0 });
    const second = apiRequest<{ ok: boolean }>("/api/skills", { retries: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });
});
