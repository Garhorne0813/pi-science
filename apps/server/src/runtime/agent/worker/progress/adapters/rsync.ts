import type { ProgressAdapter, ProgressObservation } from "../types.js";

/** `rsync --info=progress2` ends each record with `to-chk=remaining/total`, a
 *  pair of file counts from one measurement. The total is rsync's current view
 *  of the file list and rsync revises it, so it is reported as re-estimated
 *  rather than fixed: the row counts files and does not claim a stable bar. */
const CHECK = /to-chk=(\d+)\/(\d+)/g;

export const rsyncProgressAdapter: ProgressAdapter = {
  id: "rsync",
  matches(command) {
    return /(?:^|[\s|&;(])rsync(?:\s|$)/.test(command) && /--info=progress2\b/.test(command);
  },
  read(text) {
    let observation: ProgressObservation | undefined;
    for (const match of text.matchAll(CHECK)) {
      const remaining = Number(match[1]);
      const total = Number(match[2]);
      if (
        !Number.isSafeInteger(remaining) ||
        !Number.isSafeInteger(total) ||
        total <= 0 ||
        remaining > total
      )
        continue;
      observation = {
        scopeId: "files",
        scopeLabel: "Checking files",
        current: total - remaining,
        total,
        totalKind: "reestimated",
        unit: "files",
      };
    }
    return observation ? [observation] : [];
  },
};
