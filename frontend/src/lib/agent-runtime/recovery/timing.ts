import type { ConnectionRecoveryRun } from "./types";

export function waitForRecovery(ms: number, run?: ConnectionRecoveryRun): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!run) return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => { run.wake = null; resolve(); }, ms);
    run.wake = () => { globalThis.clearTimeout(timer); run.wake = null; resolve(); };
  });
}
