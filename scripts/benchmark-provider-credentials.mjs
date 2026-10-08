import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildApp } from "../apps/server/dist/app/app.js";
import { createServerModules } from "../apps/server/dist/app/server-modules.js";
import { emptyModelResourceState } from "../apps/server/dist/model-resources/model-resource-repository.js";
import { writeJsonAtomic } from "../apps/server/dist/storage/persistence.js";

// Real HTTP/Core/resource reads. Constant provider/model counts isolate growth
// in the credential file; all secrets are synthetic and no inference is sent.
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, "provider-credential-benchmark-"));
const previousHome = process.env.PI_SCIENCE_HOME;
process.env.PI_SCIENCE_HOME = root;
const config = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100,
  nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let app;
try {
  const modules = createServerModules(config, { sqliteEnabled: false });
  const template = await modules.modelResources.credentials.put({ id: "benchmark-key", kind: "api_key", backend: "managed", secret: "synthetic-benchmark-key" });
  const state = emptyModelResourceState();
  state.migration = { version: 1, completed_at: "2026-01-01T00:00:00.000Z" };
  for (let index = 0; index < 100; index++) {
    const id = `user-lab${index}`;
    state.providers.push({ id, name: id, kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "manual", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: `ep-${index}`, name: id, base_url: "http://127.0.0.1:9/v1", protocol: "openai", credential_ref: "benchmark-key", owner_provider_id: id, enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: `bind-${index}`, provider_id: id, endpoint_id: `ep-${index}`, enabled: true, priority: 1 });
    for (let model = 0; model < 100; model++) state.models.push({ provider_id: id, model_id: `model-${model}`, display_name: `Model ${index}-${model}`, enabled: true,
      capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 65536, max_output_tokens: 8192 }, capability_source: "manual" });
  }
  await modules.modelResources.repository.replace(state);
  await modules.settings.update((settings) => { settings.model = "user-lab0/model-0"; settings.thinking = "off"; });
  app = buildApp(config, modules);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const results = [];
  const budgets = { providerViewMedianMs: 2000 };
  for (const count of [1, 100, 1000]) {
    const credentials = {};
    for (let index = 0; index < count; index++) credentials[`benchmark-${index}`] = { metadata: { ...template, id: `benchmark-${index}`, owner_provider_id: `user-lab${index % 100}` }, secret: `synthetic-benchmark-${index}` };
    await writeJsonAtomic(join(root, "credentials.json"), { schema_version: 1, credentials }, { mode: 0o600 });
    for (let index = 0; index < state.endpoints.length; index++) state.endpoints[index].credential_ref = `benchmark-${index % count}`;
    await modules.modelResources.repository.replace(state);
    async function read() {
      const start = performance.now();
      const response = await fetch(`${base}/api/provider-views`);
      assert.equal(response.status, 200);
      const providers = (await response.json()).providers.filter((provider) => provider.source === "user");
      assert.equal(providers.length, 100);
      assert.equal(providers.reduce((sum, provider) => sum + provider.routing.selectable_model_count, 0), 10000);
      assert(providers.every((provider) => provider.status === "ready" && provider.credential.configured));
      return performance.now() - start;
    }
    await read();
    const fingerprint = () => Promise.all(["credentials.json", "model-resources.json", "config.json"].map(async (file) => ({ contents: await readFile(join(root, file), "utf8"), mtime: (await stat(join(root, file), { bigint: true })).mtimeNs.toString() })));
    const before = await fingerprint();
    const samples = [];
    for (let sample = 0; sample < 3; sample++) samples.push(await read());
    const after = await fingerprint();
    assert.deepEqual(after, before, "Read-only management requests must not persist observations");
    const providerViewMedianMs = median(samples);
    assert(providerViewMedianMs <= budgets.providerViewMedianMs, `${count} credentials exceeds ${budgets.providerViewMedianMs}ms budget: ${providerViewMedianMs}`);
    results.push({ credentialCount: count, providerCount: 100, modelCount: 10000, providerViewMedianMs, samples, unchangedFiles: true });
  }
  process.stdout.write(`${JSON.stringify({ node: process.version, results, budgets }, null, 2)}\n`);
} finally {
  await app?.close();
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
