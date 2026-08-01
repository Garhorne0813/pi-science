import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorMessage, apiRequest } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiErrorMessage", () => {
  it("prefers detail, then error, then message", () => {
    expect(apiErrorMessage({ detail: "d", error: "e", message: "m" })).toBe("d");
    expect(apiErrorMessage({ error: "e", message: "m" })).toBe("e");
    expect(apiErrorMessage({ message: "m" })).toBe("m");
  });

  it("falls back when the payload carries no message at all", () => {
    expect(apiErrorMessage({}, "Not Found")).toBe("Not Found");
    expect(apiErrorMessage("plain text body")).toBe("Request failed");
    expect(apiErrorMessage({ detail: "" }, "Not Found")).toBe("Request failed");
  });
});

describe("apiRequest", () => {
  it("surfaces the backend error message for failed JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Workspace access denied" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )));

    await expect(apiRequest("/api/example")).rejects.toMatchObject({
      message: "Workspace access denied",
      status: 403,
    });
  });

  it("uses the caller's fallback instead of the status text when the body says nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(apiRequest("/api/kernels/execute", { method: "POST", errorFallback: "Cell execution failed" }))
      .rejects.toThrow("Cell execution failed");
  });

  it("returns text for non-JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("plain", { status: 200 })));
    await expect(apiRequest("/api/example")).resolves.toBe("plain");
  });
});
