import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelSelectionApi, modelSelectionKeys } from "./model-selection";
import { queryClient } from "./client/query-client";

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("default selection commit acknowledgement", () => {
  it.each(["pending", "failed"])("returns the committed selection when compatibility invalidation is %s", async (state) => {
    const selection = { model: "deepseek/deepseek-flash", thinking: "high" as const };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ scope: "default", selection }), { headers: { "Content-Type": "application/json" } })));
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => state === "pending" ? new Promise<void>(() => undefined) : Promise.reject(new Error("projection offline")));
    await expect(modelSelectionApi.saveDefault(selection)).resolves.toEqual({ scope: "default", selection });
    expect(queryClient.getQueryData(modelSelectionKeys.default)).toEqual({ scope: "default", selection });
  });
});
