import { afterEach, expect, it, vi } from "vitest";
import { mcpBaseEnvironment, resolveBindings } from "./bindings.js";
afterEach(() => vi.unstubAllEnvs());
it("does not inherit control-plane secrets but resolves explicitly bound variables", () => {
  vi.stubEnv("MCP_TEST_SECRET", "hidden");
  expect(mcpBaseEnvironment()).not.toHaveProperty("MCP_TEST_SECRET");
  expect(resolveBindings({ TOKEN: { kind: "environment", name: "MCP_TEST_SECRET" } })).toEqual({ TOKEN: "hidden" });
});
it("fails closed for absent and unsupported bindings", () => {
  vi.stubEnv("MCP_TEST_MISSING", undefined);
  expect(() => resolveBindings({ TOKEN: { kind: "environment", name: "MCP_TEST_MISSING" } })).toThrow("Missing MCP");
  expect(() => resolveBindings({ TOKEN: { kind: "credential", credential_ref: "secret" } })).toThrow("Missing MCP credential");
});
it("resolves managed credentials in memory and applies delivery prefixes", () => {
  const credentials = { readSync: (id: string) => id === "secret" ? { metadata: {}, secret: "token-value" } : null };
  expect(resolveBindings({ Authorization: { kind: "credential", credential_ref: "secret", prefix: "Bearer " } }, credentials as never))
    .toEqual({ Authorization: "Bearer token-value" });
});
