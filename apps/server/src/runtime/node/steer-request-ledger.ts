import { createHash, randomUUID } from "node:crypto";
import {
  appendJsonLineUnlocked,
  readJsonLines,
  withFileWriteLock,
  workspaceFile,
} from "../../storage/persistence.js";
import type { SteerDeliveryStatus } from "@pi-science/contracts";

interface SteerRecord {
  session_id: string;
  client_message_id: string;
  content_sha256: string;
  status: SteerDeliveryStatus;
  server_instance_id: string;
  error_code?: string;
}

export type ClaimSteerResult =
  | { dispatch: true }
  | { dispatch: false; status: SteerDeliveryStatus; error_code?: string }
  | { conflict: true };

const SERVER_INSTANCE_ID = randomUUID();

function digest(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function latest(
  records: SteerRecord[],
  sessionId: string,
  clientMessageId: string,
): SteerRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const row = records[index];
    if (row?.session_id === sessionId && row.client_message_id === clientMessageId) return row;
  }
  return undefined;
}

/** Deduplicates steer delivery per client message ID. A steer has no durable
 *  transcript message, so the receipt itself is the only record that the same
 *  click was already answered. */
export class SteerRequestLedger {
  constructor(private readonly serverInstanceId: string = SERVER_INSTANCE_ID) {}

  private file(cwd: string): string {
    return workspaceFile(cwd, "steer-requests.jsonl");
  }

  async claim(
    cwd: string,
    sessionId: string,
    clientMessageId: string,
    message: string,
  ): Promise<ClaimSteerResult> {
    const file = this.file(cwd);
    const contentSha256 = digest(message);
    return withFileWriteLock(file, async () => {
      const prior = latest(await readJsonLines<SteerRecord>(file), sessionId, clientMessageId);
      if (prior) {
        if (prior.content_sha256 !== contentSha256) return { conflict: true };
        if (
          prior.server_instance_id !== this.serverInstanceId &&
          prior.status === "indeterminate"
        ) {
          return {
            dispatch: false,
            status: "indeterminate",
            ...(prior.error_code ? { error_code: prior.error_code } : {}),
          };
        }
        // A new server process cannot know whether the old one delivered the
        // steer, so a retry of an accepted receipt stays a receipt, not a send.
        return {
          dispatch: false,
          status: prior.status,
          ...(prior.error_code ? { error_code: prior.error_code } : {}),
        };
      }
      return { dispatch: true };
    });
  }

  async settle(
    cwd: string,
    sessionId: string,
    clientMessageId: string,
    message: string,
    status: SteerDeliveryStatus,
    errorCode?: string,
  ): Promise<void> {
    await withFileWriteLock(this.file(cwd), async () => {
      await appendJsonLineUnlocked(this.file(cwd), {
        session_id: sessionId,
        client_message_id: clientMessageId,
        content_sha256: digest(message),
        status,
        server_instance_id: this.serverInstanceId,
        ...(errorCode ? { error_code: errorCode } : {}),
      } satisfies SteerRecord);
    });
  }
}
