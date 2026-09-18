import type { UserMessageBlock } from "../../types/thread";

/** Pi Orbit forks immediately before the selected user entry. */
export function replayForkEntryId(block: UserMessageBlock): string {
  return block.id;
}
