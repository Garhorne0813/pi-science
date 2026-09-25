/** Opt-in timing probe for turn-level diagnostics.
 *
 * Set PI_SCIENCE_PROBE_LOG=1 to trace where a prompt spends its wall clock
 * (lock wait, activation, runtime start, event-stream health, transport) and
 * where the Pi Orbit event stream goes quiet. Off by default: it is a
 * diagnostic aid, not part of normal operation. */
const enabled = (): boolean => process.env.PI_SCIENCE_PROBE_LOG === "1";

export function probeLog(label: string, detail?: Record<string, unknown>): void {
  if (!enabled()) return;
  const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : "";
  process.stderr.write(`[probe] ${new Date().toISOString().slice(11, 23)} ${label}${suffix}\n`);
}

/** Runs `fn` and logs its duration under `label`; failures are reported too. */
export async function probeTimed<T>(label: string, fn: () => Promise<T>, detail?: () => Record<string, unknown>): Promise<T> {
  if (!enabled()) return fn();
  const startedAt = Date.now();
  try {
    const result = await fn();
    probeLog(label, { ms: Date.now() - startedAt, ...(detail?.() ?? {}) });
    return result;
  } catch (error) {
    probeLog(label, { ms: Date.now() - startedAt, failed: String(error).slice(0, 200) });
    throw error;
  }
}
