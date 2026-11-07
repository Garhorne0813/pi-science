import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readJson,
  withFileWriteLock,
  workspaceFile,
  writeJsonAtomic,
} from "../storage/persistence.js";
import { ownerProcessIdentity } from "../runtime/jobs/job-lease-manager.js";

const processIdentity = z
  .object({
    kind: z.enum(["linux-proc-start-ticks", "ps-lstart-utc", "windows-start-ticks"]),
    platform: z.string(),
    value: z.string().min(1),
  })
  .strict();
const ticket = z
  .object({
    id: z.string().uuid(),
    pid: z.number().int().positive(),
    process_identity: processIdentity.optional(),
  })
  .strict();
const stateSchema = z
  .object({ active: z.array(ticket).max(4), waiting: z.array(ticket).max(16) })
  .strict();
const identity = ownerProcessIdentity(process.pid, process.platform);
const alive = (
  item: z.infer<typeof ticket>,
  identities: Map<number, ReturnType<typeof ownerProcessIdentity>>,
) => {
  if (!item.process_identity) return false; // Legacy PID-only tickets cannot prove ownership.
  // Reaping an exited owner must not spawn PowerShell/ps just to discover it
  // is gone. Live PIDs still require the start identity check to fence reuse.
  try {
    process.kill(item.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  if (!identities.has(item.pid))
    identities.set(item.pid, ownerProcessIdentity(item.pid, process.platform));
  const current = identities.get(item.pid);
  if (!current) {
    try {
      process.kill(item.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    }
    throw new Error("Cannot verify MCP queue owner process identity");
  }
  return (
    current.kind === item.process_identity.kind &&
    current.platform === item.process_identity.platform &&
    current.value === item.process_identity.value
  );
};
/** Cross-worker FIFO, scoped to a workspace/project/connector identity. Dead
 * owners are reclaimed; a live owner is never evicted merely for taking time. */
export async function acquireMcpCall(
  cwd: string,
  connector: string,
  signal?: AbortSignal,
  queueTimeoutMs = 30_000,
) {
  signal?.throwIfAborted();
  if (!identity) throw new Error("Cannot establish MCP queue process identity");
  const ownedTicket = { id: randomUUID(), pid: process.pid, process_identity: identity };
  const path = workspaceFile(
    cwd,
    `mcp-call-queues/${createHash("sha256").update(connector).digest("hex")}.json`,
  );
  const id = ownedTicket.id,
    started = Date.now();
  let admitted = false;
  const update = async (fn: (state: z.infer<typeof stateSchema>) => void) =>
    withFileWriteLock(path, async () => {
      const state = stateSchema.parse(await readJson(path, { active: [], waiting: [] }));
      const identities = new Map([[process.pid, identity]]);
      state.active = state.active.filter((item) => alive(item, identities));
      state.waiting = state.waiting.filter((item) => alive(item, identities));
      fn(state);
      await writeJsonAtomic(path, state);
    });
  const remove = () =>
    update((state) => {
      state.active = state.active.filter((item) => item.id !== id);
      state.waiting = state.waiting.filter((item) => item.id !== id);
    });
  try {
    await update((state) => {
      signal?.throwIfAborted();
      if (state.waiting.length >= 16) throw new Error("MCP connector queue is full");
      state.waiting.push(ownedTicket);
    });
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() - started >= queueTimeoutMs)
        throw new Error("MCP connector queue wait timed out");
      await update((state) => {
        signal?.throwIfAborted();
        if (state.active.length < 4 && state.waiting[0]?.id === id) {
          state.waiting.shift();
          state.active.push(ownedTicket);
          admitted = true;
        }
      });
      if (admitted) break;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("MCP queue cancelled"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 40);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          signal.removeEventListener("abort", abort);
          abort();
        }
      });
    }
    return { queuedMs: Date.now() - started, release: remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
