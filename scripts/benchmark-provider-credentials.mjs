import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildApp } from "../apps/server/dist/app/app.js";
import { createServerModules } from "../apps/server/dist/app/server-modules.js";
import { ModelConfigService } from "../apps/server/dist/model-config/model-config-service.js";
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
  const native = new ModelConfigService();
  const providers = {};
  const references = {};
  for (let index = 0; index < 100; index++) {
    const id = `user-lab${index}`;
    providers[id] = { name: `Lab ${index}`, api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: Array.from({ length: 100 }, (_, model) => ({ id: `model-${model}`, name: `Model ${index}-${model}`, reasoning: false, contextWindow: 65536, maxTokens: 8192 })) };
    references[id] = "benchmark-key";
  }
  await native.update(0, (snapshot) => { snapshot.config = { providers }; snapshot.credential_refs = references; });
  await modules.settings.update((settings) => { settings.model = "user-lab0/model-0"; settings.thinking = "off"; });
  app = buildApp(config, modules);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const results = [];
  const budgets = { providerViewMedianMs: 2000 };
  for (const count of [1, 100, 1000]) {
    const credentials = {};
    for (let index = 0; index < count; index++) credentials[`benchmark-${index}`] = { metadata: { ...template, id: `benchmark-${index}`, owner_provider_id: `user-lab${index % 100}` }, secret: `synthetic-benchmark-${index}` };
    await writeJsonAtomic(join(root, "credentials.json"), { schema_version: 1, credentials }, { mode: 0o600 });
    await native.update(native.readSync().revision, (snapshot) => { for (let index = 0; index < 100; index++) snapshot.credential_refs[`user-lab${index}`] = `benchmark-${index % count}`; });
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
    const fingerprint = () => Promise.all(["credentials.json", "models.json", "config.json"].map(async (file) => ({ contents: await readFile(join(root, file), "utf8"), mtime: (await stat(join(root, file), { bigint: true })).mtimeNs.toString() })));
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
