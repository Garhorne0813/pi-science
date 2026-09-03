import { expect, it, vi } from "vitest";
vi.mock("node:dns", () => ({
  lookup: (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4),
}));
vi.mock("../security/outbound-security.js", async (original) => ({
  ...await original<object>(),
  // Simulate a public preflight followed by a private connection-time answer.
  validateConnectorOutboundUrl: async (url: string) => new URL(url),
}));
vi.mock("../security/egress-audit.js", () => ({ egressAuditEnabled: async () => true, recordEgress: vi.fn() }));
import { createMcpFetch } from "./runtime-fetch.js";
import { recordEgress } from "../security/egress-audit.js";
it("blocks DNS rebinding at the actual socket lookup", async () => {
  const request = createMcpFetch({ connectorId: "rebind", endpoint: "http://rebind.example.test", allowPrivate: false });
  await expect(request("http://rebind.example.test")).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("private or reserved") }) });
  expect(recordEgress).toHaveBeenCalledWith(expect.objectContaining({ approved: false, note: "mcp_connection_failed" }));
});
