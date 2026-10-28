import { Worker } from "node:worker_threads";
import { DiscoveryError, discoveryBackendAvailable, type DiscoveryInput, type Operation } from "./workspace-discovery-contract.js";
import type { discover } from "./workspace-discovery.js";

/** Isolate matching/ignore parsing so even pathological glob metadata cannot
 * block Agent control, cancellation or the hard wall-clock deadline. No child
 * process, shell, environment-selected executable or host fallback is involved. */
export async function runDiscovery(operation: Operation, cwd: string, input: DiscoveryInput, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof discover>>> {
  if (signal?.aborted) throw new DiscoveryError("cancelled");
  if (!discoveryBackendAvailable()) throw new DiscoveryError("tool_unavailable");
  const source = import.meta.url.endsWith(".ts");
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      if (workerData.loader) { const { register } = await import(workerData.loader); register(); }
      const { discover, DiscoveryError } = await import(workerData.module);
      try { parentPort.postMessage({ result: await discover(workerData.operation, workerData.cwd, workerData.input) }); }
      catch (error) { parentPort.postMessage({ code: error instanceof DiscoveryError ? error.code : 'tool_unavailable' }); }
    })().catch(() => parentPort.postMessage({ code: 'tool_unavailable' }));
  `, { eval: true, workerData: { module: new URL(`./workspace-discovery.${source ? "ts" : "js"}`, import.meta.url).href,
    loader: source ? import.meta.resolve("tsx/esm/api") : undefined, operation, cwd, input },
    resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise((done, reject) => {
      const fail = (code: string) => reject(new DiscoveryError(code));
      cancel = () => fail("cancelled"); signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      timer = setTimeout(() => fail("timeout"), 5000);
      worker.once("message", (message: { result?: Awaited<ReturnType<typeof discover>>; code?: string }) => {
        if (message.result) done(message.result); else fail(message.code ?? "tool_unavailable");
      });
      worker.once("error", () => fail("tool_unavailable"));
      worker.once("exit", () => fail("tool_unavailable"));
    });
  } finally {
    clearTimeout(timer); if (cancel) signal?.removeEventListener("abort", cancel);
    await worker.terminate();
  }
}
