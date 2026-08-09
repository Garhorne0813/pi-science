import { appendJsonLine, readJsonLines, workspaceFile } from "../../storage/persistence.js";

/** Persisted per-turn artifact summary (the "files this turn produced"
 *  preview). Kept in `<workspace>/.pi-science/turn-artifacts.jsonl` so the
 *  conversation UI can restore the strips after a reload without rescanning
 *  the workspace. */

export interface TurnArtifactItem {
  path: string;
  kind: string;
  mime: string;
  size: number;
  artifactId?: string;
  version?: number;
}

export interface TurnArtifactRecord {
  turn_id: string;
  session_id: string;
  assistant_message_id: string | null;
  ended_at: string;
  artifacts: TurnArtifactItem[];
  /** 1-based turn ordinal within the session, persisted across runtime
   *  rebuilds so the frontend can anchor strips to the correct turn even
   *  when a runtime was idle-cleaned or restarted between turns. */
  turn_ordinal?: number | null;
}

export class TurnArtifactRepository {
  private file(cwd: string): string {
    return workspaceFile(cwd, "turn-artifacts.jsonl");
  }

  async append(cwd: string, record: TurnArtifactRecord): Promise<void> {
    await appendJsonLine(this.file(cwd), record);
  }

  async forSession(cwd: string, sessionId: string): Promise<TurnArtifactRecord[]> {
    const records = await readJsonLines<TurnArtifactRecord>(this.file(cwd));
    return records.filter((record) => record.session_id === sessionId);
  }

  /** Next 1-based turn ordinal for a session: the maximum persisted
   *  turn_ordinal plus one, or 1 when the session has no records yet.
   *  Ordinals survive runtime rebuilds because they are derived from
   *  persisted state, not from in-memory runtime fields. */
  async nextTurnOrdinal(cwd: string, sessionId: string): Promise<number> {
    const records = await this.forSession(cwd, sessionId);
    let max = 0;
    for (const record of records) {
      const ordinal = Number(record.turn_ordinal);
      if (Number.isInteger(ordinal) && ordinal > max) max = ordinal;
    }
    return max + 1;
  }
}

export const turnArtifactRepository = new TurnArtifactRepository();
