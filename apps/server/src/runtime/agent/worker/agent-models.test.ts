import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../../../model-resources/credential-store.js";
import { ModelResourceRepository } from "../../../model-resources/model-resource-repository.js";
import { agentModelCatalog, agentModels } from "./agent-models.js";

const previousHome = process.env.PI_SCIENCE_HOME;
const roots: string[] = [];
afterEach(async () => {
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent-core model credentials", () => {
  it("resolves a Settings-managed DeepSeek key for the built-in provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-core-models-"));
    roots.push(root);
    process.env.PI_SCIENCE_HOME = root;
    await new CredentialStore().putRaw("deepseek-test", { kind: "api_key", backend: "managed" }, "test-secret");
    await new ModelResourceRepository().update((state) => { state.credential_refs.deepseek = "deepseek-test"; });
    const models = agentModels();
    expect(models.getModel("deepseek", "deepseek-v4-pro")).toBeDefined();
    expect(models.getModel("deepseek", "deepseek-v4-flash")).toBeUndefined();
    expect(models.getModel("deepseek", "deepseek-flash")).toBeDefined();
    expect(await models.getAuth("deepseek")).toMatchObject({ auth: { apiKey: "test-secret" } });
    const catalog = await agentModelCatalog();
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "deepseek", id: "deepseek-v4-pro" })]));
    expect(catalog).not.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "deepseek", id: "deepseek-v4-flash" })]));
  });
});
