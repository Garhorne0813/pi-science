import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { JobOwnerProcessIdentity, JobOwnership, JobRecord, JobProcessIdentity } from "./job-types.js";

const ORPHAN_GRACE_MS = 15_000;
const OWNERSHIP_LEASE_MS = 30_000;
const OWNERSHIP_HEARTBEAT_MS = 5_000;

export interface JobLeaseHooks {
  platform?: NodeJS.Platform;
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  ownerProcessAlive?: (pid: number, ownership: Readonly<JobOwnership>) => boolean;
  ownerProcessIdentity?: (pid: number, platform: NodeJS.Platform) => JobOwnerProcessIdentity | null;
  reapChild?: (identity: Readonly<NonNullable<JobOwnership["child"]>>) => "reaped" | "identity-mismatch" | "unverifiable" | "missing";
  onHeartbeatStarted?: (jobId: string) => void;
  onHeartbeatStopped?: (jobId: string) => void;
  stopChild?: (jobId: string) => void;
}

export type HeartbeatPersistence = (record: JobRecord, ownership: JobOwnership, now: number) => Promise<JobRecord | null>;
export type CurrentRecord = (record: JobRecord) => Promise<JobRecord | null>;

const LIVE_JOB_OWNERS = new Set<string>();

/** Owns lease identity, heartbeat scheduling and orphan eligibility decisions. */
export class JobLeaseManager {
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly instanceId = `coordinator_${randomUUID()}`;
  private readonly processIdentity: JobOwnerProcessIdentity | null;
  private readonly processStartedAt: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly hooks: JobLeaseHooks = {}) {
    this.platform = hooks.platform ?? process.platform;
    this.processIdentity = hooks.ownerProcessIdentity ? hooks.ownerProcessIdentity(process.pid, this.platform) : ownerProcessIdentity(process.pid, this.platform);
    this.processStartedAt = this.processIdentity?.value ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
    this.now = hooks.now ?? Date.now;
    this.leaseMs = Math.max(100, hooks.leaseMs ?? OWNERSHIP_LEASE_MS);
    this.heartbeatMs = Math.max(25, Math.min(hooks.heartbeatMs ?? OWNERSHIP_HEARTBEAT_MS, Math.floor(this.leaseMs / 2)));
  }

  createOwnership(now = this.now()): JobOwnership {
    const ownership: JobOwnership = {
      instance_id: this.instanceId,
      pid: process.pid,
      process_started_at: this.processStartedAt,
      ...(this.processIdentity ? { process_identity: this.processIdentity } : {}),
      generation: 1,
      token: randomUUID(),
      heartbeat_at: new Date(now).toISOString(),
      lease_expires_at: new Date(now + this.leaseMs).toISOString(),
    };
    LIVE_JOB_OWNERS.add(ownership.token);
    return ownership;
  }

  release(ownership?: JobOwnership): void {
    if (ownership) LIVE_JOB_OWNERS.delete(ownership.token);
  }

  matches(left: JobOwnership | undefined, right: JobOwnership | undefined): boolean {
    return Boolean(left && right && left.instance_id === right.instance_id && left.generation === right.generation && left.token === right.token);
  }

  shouldHeal(record: JobRecord, now = this.now()): boolean {
    if (!record.ownership) return now - Date.parse(record.created_at) >= ORPHAN_GRACE_MS;
    return Date.parse(record.ownership.lease_expires_at) <= now && !this.ownerCrediblyAlive(record.ownership);
  }

  orphanDiagnostic(record: JobRecord, reapChild: (ownership: JobOwnership) => string): string {
    return record.ownership
      ? `job owner lease expired and owner process is no longer active (${record.ownership.instance_id}); ${reapChild(record.ownership)}`
      : "job was orphaned by a server restart";
  }

  ownerCrediblyAlive(ownership: JobOwnership): boolean {
    if (LIVE_JOB_OWNERS.has(ownership.token)) return true;
    if (this.hooks.ownerProcessAlive) return this.hooks.ownerProcessAlive(ownership.pid, ownership);
    if (ownership.pid === process.pid) return false;
    try {
      process.kill(ownership.pid, 0);
      const expected = ownership.process_identity;
      if (!expected) return true;
      if (expected.platform !== this.platform) return true;
      const identity = this.hooks.ownerProcessIdentity ? this.hooks.ownerProcessIdentity(ownership.pid, this.platform) : ownerProcessIdentity(ownership.pid, this.platform);
      return !identity || identity.kind !== expected.kind || identity.platform !== expected.platform ? true : identity.value === expected.value;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  startHeartbeat(record: JobRecord, currentRecord: CurrentRecord, persist: HeartbeatPersistence): void {
    if (!record.ownership || this.heartbeats.has(record.job_id)) return;
    const refresh = async () => {
      const ownership = record.ownership;
      if (!ownership) return;
      const current = await currentRecord(record);
      if (!current || current.status === "succeeded" || current.status === "failed" || current.status === "cancelled" || current.status === "timed_out" || !this.matches(current.ownership, ownership)) {
        if (current?.status === "cancelled") this.hooks.stopChild?.(record.job_id);
        this.stopHeartbeat(record.job_id);
        return;
      }
      const updated = await persist(record, ownership, this.now());
      if (!updated || updated.status === "succeeded" || updated.status === "failed" || updated.status === "cancelled" || updated.status === "timed_out" || !this.matches(updated.ownership, ownership)) {
        if (updated?.status === "cancelled") this.hooks.stopChild?.(record.job_id);
        this.stopHeartbeat(record.job_id);
        return;
      }
      record.ownership = updated.ownership;
    };
    let refreshing = false;
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void refresh().catch(() => undefined).finally(() => { refreshing = false; });
    }, this.heartbeatMs);
    timer.unref();
    this.heartbeats.set(record.job_id, timer);
    this.hooks.onHeartbeatStarted?.(record.job_id);
  }

  stopHeartbeat(id: string): void {
    const timer = this.heartbeats.get(id);
    if (!timer) return;
    clearInterval(timer);
    this.heartbeats.delete(id);
    this.hooks.onHeartbeatStopped?.(id);
  }

  stopAllHeartbeats(): void {
    for (const id of [...this.heartbeats.keys()]) this.stopHeartbeat(id);
  }
}

function ownerProcessIdentity(pid: number, platform: NodeJS.Platform): JobOwnerProcessIdentity | null {
  const linux = childProcessIdentity(pid, platform);
  if (linux) return { ...linux, platform };
  if (platform === "win32") return null;
  const result = spawnSync("ps", ["-ww", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", windowsHide: true, env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value ? { kind: "ps-lstart-utc", platform, value } : null;
}

function childProcessIdentity(pid: number, platform: NodeJS.Platform): JobProcessIdentity | null {
  if (platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const commandStart = stat.indexOf("(");
    const commandEnd = stat.lastIndexOf(")");
    if (commandStart < 1 || commandEnd <= commandStart || !/^\d+\s$/.test(stat.slice(0, commandStart))) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks && /^\d+$/.test(startTicks) ? { kind: "linux-proc-start-ticks", value: startTicks } : null;
  } catch {
    return null;
  }
}
