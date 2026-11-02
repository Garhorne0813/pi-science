import { expect, it } from "vitest";
import { fingerprintMcpConnection } from "./connection-identity.js";

it("canonicalizes object key order but preserves argument order and connector names", () => {
  const raw = { command: "node", args: ["server.js", "--flag"], __piScienceHeaders: { Authorization: { kind: "credential", credential_ref: "one", prefix: "Bearer " } } };
  const expected = fingerprintMcpConnection("server", raw);
  expect(fingerprintMcpConnection("server", { __piScienceHeaders: { Authorization: { prefix: "Bearer ", credential_ref: "one", kind: "credential" } }, args: raw.args, command: "node" })).toBe(expected);
  expect(fingerprintMcpConnection("server", { ...raw, args: [...raw.args].reverse() })).not.toBe(expected);
  expect(fingerprintMcpConnection("substituted", raw)).not.toBe(expected);
});

it("leaves mutable tool decisions to authoritative dispatch checks", () => {
  const raw = { transport: "stdio", command: "node", args: ["server.js"] };
  expect(fingerprintMcpConnection("server", { ...raw, approveTools: false, __piScienceAllowedTools: ["echo"], includeTools: ["echo"], excludeTools: ["other"], __piScienceToolCount: 3 })).toBe(fingerprintMcpConnection("server", raw));
});
