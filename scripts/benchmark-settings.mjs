import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildApp } from "../apps/server/dist/app/app.js";
import { createServerModules } from "../apps/server/dist/app/server-modules.js";
import { emptyModelResourceState } from "../apps/server/dist/model-resources/model-resource-repository.js";
import { agentModelCatalog } from "../apps/server/dist/runtime/agent/worker/agent-models.js";

// Run separately from parallel unit suites, against the built Node server and
// real repositories/catalog/resolver. No upstream inference requests are made.
const recordOnly = process.argv.includes("--record-only");
const scratch = fileURLToPath(new URL("../.cache/", import.meta.url));
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, "settings-benchmark-"));
const previousHome = process.env.PI_SCIENCE_HOME;
process.env.PI_SCIENCE_HOME = root;
const config = { host: "127.0.0.1", port: 0, corsOrigins: [], maxBodyBytes: 10_000_000, upstreamTimeoutMs: 100,
  nodeSessions: false, nodeSse: false, nodeFiles: false, nodePiManager: false, logLevel: "silent" };
let app;
const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
try {
  const modules = createServerModules(config, { sqliteEnabled: false });
  const state = emptyModelResourceState();
  state.migration = { version: 1, completed_at: "2026-01-01T00:00:00.000Z" };
  const credential = await modules.modelResources.credentials.put({ id: "benchmark-key", kind: "api_key", backend: "managed", secret: "synthetic-benchmark-credential" });
  for (let provider = 0; provider < 100; provider++) {
    const id = `user-lab${provider}`;
    state.providers.push({ id, name: `Lab ${provider}`, kind: "user", adapter: "openai-compatible", enabled: true, catalog_mode: "manual", auth_kind: "api_key", source: "user" });
    state.endpoints.push({ id: `ep-${provider}`, name: `Lab ${provider}`, base_url: "http://127.0.0.1:9/v1", protocol: "openai", credential_ref: credential.id, enabled: true, health: "unknown", data_egress: "local" });
    state.bindings.push({ id: `bind-${provider}`, provider_id: id, endpoint_id: `ep-${provider}`, enabled: true, priority: 1 });
    for (let model = 0; model < 100; model++) state.models.push({ provider_id: id, model_id: `model-${model}`, display_name: `Model ${provider}-${model}`, enabled: true,
      capabilities: { reasoning: false, thinking_levels: ["off"], context_window: 65536, max_output_tokens: 8192 }, capability_source: "manual" });
  }
  await modules.modelResources.repository.replace(state);
  await modules.settings.update((settings) => { settings.model = "user-lab0/model-0"; settings.thinking = "off"; });
  app = buildApp(config, modules);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  async function configRead() {
    const start = performance.now();
    const response = await fetch(`${base}/api/settings/config`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.available_models.filter((model) => model.provider.startsWith("user-")).length, 10000);
    assert.equal(payload.providers.filter((provider) => provider.custom).length, 100);
    return performance.now() - start;
  }
  // Exclude server/module cold imports and one legitimate capability repair.
  await configRead();
  const paths = [join(root, "config.json"), join(root, "model-resources.json")];
  const fingerprints = async () => Promise.all(paths.map(async (path) => ({ contents: await readFile(path, "utf8"), mtime: (await stat(path, { bigint: true })).mtimeNs.toString() })));
  const before = await fingerprints();
  const catalogSamples = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    assert.equal((await agentModelCatalog()).filter((model) => model.provider.startsWith("user-")).length, 10000);
    catalogSamples.push(performance.now() - start);
  }
  const requestSamples = [];
  const eventLoopSamples = [];
  const pending = new Set();
  let previousTick = performance.now();
  const probe = setInterval(() => {
    const current = performance.now();
    eventLoopSamples.push(Math.max(0, current - previousTick - 5));
    previousTick = current;
    // A real health request runs on the same server during each config read.
    const start = performance.now();
    const task = fetch(`${base}/api/health`).then(async (response) => {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      return performance.now() - start;
    });
    pending.add(task);
  }, 5);
  try { for (let sample = 0; sample < 3; sample++) requestSamples.push(await configRead()); }
  finally { clearInterval(probe); }
  const healthSamples = await Promise.all(pending);
  assert.ok(healthSamples.length > 0 && eventLoopSamples.length > 0, "Concurrent health/timer probes must produce samples");
  const after = await fingerprints();
  const metrics = { providers: 100, models: 10000,
    catalogMedianMs: median(catalogSamples), configMedianMs: median(requestSamples),
    eventLoopMaxDelayMs: Math.max(0, ...eventLoopSamples), healthP95Ms: [...healthSamples].sort((a, b) => a - b)[Math.floor(healthSamples.length * 0.95)] ?? 0,
    unchangedFiles: JSON.stringify(before) === JSON.stringify(after), catalogSamples, requestSamples };
  const budgets = { catalogMedianMs: 500, configMedianMs: 2000, eventLoopMaxDelayMs: 500, healthP95Ms: 750 };
  console.log(JSON.stringify({ metrics, budgets, node: process.version, platform: process.platform }, null, 2));
  if (!recordOnly) {
    assert.equal(metrics.unchangedFiles, true, "Repeated Settings GET must not rewrite config/resource files");
    for (const [metric, budget] of Object.entries(budgets)) assert.ok(metrics[metric] <= budget, `${metric}: ${metrics[metric].toFixed(1)}ms exceeds ${budget}ms budget`);
  }
} finally {
  await app?.close();
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
