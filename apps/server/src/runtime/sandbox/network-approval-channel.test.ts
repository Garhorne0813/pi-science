import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  networkApprovalEndpoint,
  startNetworkApprovalChannel,
} from "./network-approval-channel.js";
import { requestNetworkApproval } from "./network-approval-client.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function channel(approve: Parameters<typeof startNetworkApprovalChannel>[2]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "network-channel-")));
  vi.stubEnv("PI_SCIENCE_HOME", root);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await startNetworkApprovalChannel(root, "session", approve);
  cleanup.push(server.close);
  return { server, root, endpoint: (await networkApprovalEndpoint(root, "session"))! };
}
it("authenticates launcher requests and removes its descriptor on shutdown", async () => {
  const approve = vi.fn(async () => true);
  const { root, endpoint, server } = await channel(approve);
  expect(
    await requestNetworkApproval(
      { ...endpoint, token: "0".repeat(64) },
      "api.example.org",
      "analysis",
      AbortSignal.timeout(1000),
    ),
  ).toBe(false);
  expect(approve).not.toHaveBeenCalled();
  expect(
    await requestNetworkApproval(endpoint, "api.example.org", "mcp", AbortSignal.timeout(1000)),
  ).toBe(true);
  expect(approve).toHaveBeenCalledWith(
    { domain: "api.example.org", profile: "mcp" },
    expect.any(AbortSignal),
  );
  await server.close();
  expect(await networkApprovalEndpoint(root, "session")).toBeUndefined();
});
it("cancels a browser approval when the launcher request is aborted", async () => {
  let aborted = false;
  const { endpoint } = await channel(
    async (_request, signal) =>
      new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(false);
          },
          { once: true },
        ),
      ),
  );
  expect(
    await requestNetworkApproval(endpoint, "api.example.org", "analysis", AbortSignal.timeout(100)),
  ).toBe(false);
  await vi.waitFor(() => expect(aborted).toBe(true));
});
