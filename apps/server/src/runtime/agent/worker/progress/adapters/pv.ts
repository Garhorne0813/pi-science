import type { ProgressAdapter, ProgressObservation } from "../types.js";

/** `pv` reports whatever its format string says. Its default and `-n` output is
 *  a percentage with no denominator, which cannot be turned back into a
 *  measurement, so the adapter reads only a format that asks for both numbers.
 *  `pv --format '%b/%s '` prints bytes moved and total size separated by a
 *  slash, and the separator is what survives the control-byte cleaning. */
const PAIR = /(\d+)\/(\d+)/g;

export const pvProgressAdapter: ProgressAdapter = {
  id: "pv",
  matches(command) {
    return /(?:^|[\s|&;(])pv(?:\s|$)/.test(command) && /(?:--format|-\w*f)\b/.test(command);
  },
  read(text) {
    let observation: ProgressObservation | undefined;
    for (const match of text.matchAll(PAIR)) {
      const done = Number(match[1]);
      const total = Number(match[2]);
      if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || total <= 0 || done > total) continue;
      observation = { scopeId: `bytes:${total}`, scopeLabel: "Transfer", current: done, total, totalKind: "fixed", unit: "bytes" };
    }
    return observation ? [observation] : [];
  },
};
