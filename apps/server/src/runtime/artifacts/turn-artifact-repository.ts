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
}

export const turnArtifactRepository = new TurnArtifactRepository();
