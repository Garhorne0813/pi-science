import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appendJsonLineUnlocked, metadataRoot, readJsonLines, withFileWriteLock } from "../persistence.js";
import { listReducedLoops, reduceResearchRecords } from "./reducer.js";
import type { ResearchRecord, ResearchSnapshot } from "./types.js";

export class ResearchRepository {
  constructor(readonly cwd: string) {}

  private path(): string { return join(metadataRoot(this.cwd), "research-records-v2.jsonl"); }
  private lockPath(): string { return join(metadataRoot(this.cwd), ".research-loop-lock"); }

  records(): Promise<ResearchRecord[]> { return readJsonLines<ResearchRecord>(this.path()); }

  async loops() { return listReducedLoops(await this.records()); }

  async snapshot(loopId: string): Promise<ResearchSnapshot> {
    return reduceResearchRecords(await this.records(), loopId);
  }

  async locked<T>(operation: (records: ResearchRecord[]) => Promise<T>): Promise<T> {
    return withFileWriteLock(this.lockPath(), async () => operation(await this.records()));
  }

  async appendUnlocked(
    recordType: string,
    payload: Record<string, unknown>,
    extra: Partial<ResearchRecord> = {},
  ): Promise<ResearchRecord> {
    const record: ResearchRecord = {
      schema_version: 2,
      record_id: `record-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      record_type: recordType,
      workspace_id: this.cwd,
      created_at: new Date().toISOString(),
      producer: "node-research-orchestrator",
      payload,
      ...extra,
    };
    await appendJsonLineUnlocked(this.path(), record);
    return record;
  }

  async append(recordType: string, payload: Record<string, unknown>, extra: Partial<ResearchRecord> = {}) {
    return this.locked(() => this.appendUnlocked(recordType, payload, extra));
  }
}
