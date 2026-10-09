import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelSelectionApi, modelSelectionKeys } from "./model-selection";
import { queryClient } from "./client/query-client";

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("default selection commit acknowledgement", () => {
  it("sends validation cwd without changing the global cache owner", async () => {
    const selection = { model: "user-lab/model", thinking: "high" as const };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ scope: "default", selection }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await modelSelectionApi.saveDefault(selection, "/lab/work space");
    expect(fetch).toHaveBeenCalledWith("/api/model-selection/default?cwd=%2Flab%2Fwork%20space", expect.objectContaining({ method: "PUT", body: JSON.stringify(selection) }));
    expect(queryClient.getQueryData(modelSelectionKeys.default)).toEqual({ scope: "default", selection });
  });

  it.each(["pending", "failed"])("returns the committed selection when compatibility invalidation is %s", async (state) => {
    const selection = { model: "deepseek/deepseek-flash", thinking: "high" as const };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ scope: "default", selection }), { headers: { "Content-Type": "application/json" } })));
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => state === "pending" ? new Promise<void>(() => undefined) : Promise.reject(new Error("projection offline")));
    await expect(modelSelectionApi.saveDefault(selection)).resolves.toEqual({ scope: "default", selection });
    expect(queryClient.getQueryData(modelSelectionKeys.default)).toEqual({ scope: "default", selection });
  });
});
