import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { pathIsInside } from "../../support/platform-utils.js";

export class WorkspaceLifecycleBusyError extends Error {
  constructor() { super("Workspace lifecycle change or agent admission is in progress; retry when it finishes"); this.name = "WorkspaceLifecycleBusyError"; }
}
// Shared by all app-owned session services and worker managers in this control-plane process.
const leases = new Map<string, { readers: number; mutation: boolean }>();
function identity(path: string): string {
  let parent = resolve(path); const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(parent), ...suffix); }
    catch { const next = dirname(parent); if (next === parent) return resolve(path); suffix.unshift(basename(parent)); parent = next; }
  }
}
function overlaps(left: string, right: string): boolean { return pathIsInside(left, right, true) || pathIsInside(right, left, true); }
function release(key: string): void { const state = leases.get(key); if (state && !state.readers && !state.mutation) leases.delete(key); }
/** Hold from before validation/preparation until operation admission is acknowledged. */
export async function withWorkspaceAdmission<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const key = identity(cwd); const state = leases.get(key) ?? { readers: 0, mutation: false };
  if ([...leases].some(([path, state]) => state.mutation && overlaps(path, key))) throw new WorkspaceLifecycleBusyError();
  state.readers++; leases.set(key, state);
  try { return await operation(); }
  finally { state.readers--; release(key); }
}
/** Non-queuing exclusive reservation: keep active checks, idle-worker drain, mutation and rollback atomic with admission. */
export async function withWorkspaceMutation<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(identity))];
  if ([...leases].some(([path, state]) => (state.readers > 0 || state.mutation) && keys.some((key) => overlaps(path, key)))) throw new WorkspaceLifecycleBusyError();
  for (const key of keys) leases.set(key, { readers: 0, mutation: true });
  try { return await operation(); }
  finally { for (const key of keys) { leases.get(key)!.mutation = false; release(key); } }
}
