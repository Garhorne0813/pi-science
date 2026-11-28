import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { registerModelResourceRoutes } from "./model-resource-routes.js";
import { ModelResourceService } from "../../model-resources/model-resource-service.js";
import type { NodeSessionService } from "../../runtime/node/node-session-service.js";
import { SettingsStore } from "../../storage/settings-store.js";
let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it("keeps MCP credentials inaccessible and immutable through retired model APIs", async () => {
  root = await mkdtemp(join(tmpdir(), "pi-retired-http-"));
  vi.stubEnv("PI_SCIENCE_HOME", root);
  const service = new ModelResourceService();
  const key = await service.credentials.put({
    kind: "api_key",
    backend: "managed",
    secret: "mcp-secret",
    owner_kind: "mcp",
    owner_id: "connector-1",
  });
  const app = Fastify();
  registerModelResourceRoutes(
    app,
    { reloadConfiguration: async () => [] } as unknown as NodeSessionService,
    new SettingsStore(),
    service.repository,
  );
  try {
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const response = await app.inject({ method, url: `/api/credentials/${key.id}` });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("mcp-secret");
    }
    expect((await service.credentials.getForRuntime(key.id))?.secret).toBe("mcp-secret");
  } finally {
    await app.close();
  }
});
