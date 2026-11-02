import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./workspace-discovery-native.js", () => ({ darwinDirectory: undefined }));
import { discover, discoveryBackendAvailable } from "./workspace-discovery.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it.each(["ls", "glob", "grep"] as const)("macOS %s fails closed without the optional native module", async operation => {
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  expect(discoveryBackendAvailable()).toBe(false);
  await expect(discover(operation, resolve("workspace"), { limit: 1 })).rejects.toMatchObject({ code: "tool_unavailable" });
});
