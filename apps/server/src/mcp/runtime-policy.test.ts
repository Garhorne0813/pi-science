import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { operatorFetch } from "../network/operator-fetch.js";
import { authorizeMcpTool } from "./runtime-policy.js";

vi.mock("../network/operator-fetch.js", () => ({ operatorFetch: vi.fn() }));
const expected = { connectorId: "connector", projectId: "project", toolName: "echo", connectorRevision: 2, settingsRevision: 1 };
beforeEach(() => {
  vi.stubEnv("PI_SCIENCE_BACKEND_URL", "http://127.0.0.1:8787");
  vi.stubEnv("PI_SCIENCE_INTERNAL_TOKEN", "synthetic-policy-token");
  vi.mocked(operatorFetch).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("sends revision-bound policy checks to the authenticated control plane", async () => {
  vi.mocked(operatorFetch).mockResolvedValue(new Response(JSON.stringify({ decision: "ask" })));
  expect(await authorizeMcpTool("/workspace", expected)).toBe("ask");
  const [url, init] = vi.mocked(operatorFetch).mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:8787/api/mcp/runtime/authorize?cwd=%2Fworkspace");
  expect(init?.headers).toMatchObject({ "x-pi-science-internal-token": "synthetic-policy-token" });
  expect(JSON.parse(String(init?.body))).toEqual(expected);
  expect(init?.redirect).toBe("error");
});

it("refuses to use the snapshot when the authority is not configured", async () => {
  vi.stubEnv("PI_SCIENCE_BACKEND_URL", "");
  await expect(authorizeMcpTool("/workspace", expected)).rejects.toThrow("authority is unavailable");
  expect(operatorFetch).not.toHaveBeenCalled();
});

it.each([403, 409, 500])("fails closed on authority HTTP %s", async (status) => {
  vi.mocked(operatorFetch).mockResolvedValue(new Response("{}", { status }));
  await expect(authorizeMcpTool("/workspace", expected)).rejects.toThrow(`HTTP ${status}`);
});

it("fails closed on a network error or malformed authority response", async () => {
  vi.mocked(operatorFetch).mockRejectedValueOnce(new Error("authority offline"));
  await expect(authorizeMcpTool("/workspace", expected)).rejects.toThrow("authority offline");
  vi.mocked(operatorFetch).mockResolvedValueOnce(new Response(JSON.stringify({ decision: "deny" })));
  await expect(authorizeMcpTool("/workspace", expected)).rejects.toThrow();
});

it("rejects invalid revision metadata before sending a request", async () => {
  await expect(authorizeMcpTool("/workspace", { ...expected, connectorRevision: 0 })).rejects.toThrow();
  expect(operatorFetch).not.toHaveBeenCalled();
});
