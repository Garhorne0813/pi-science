import type { ProgressAdapter, ProgressObservation } from "../types.js";

/** `pv` measures its own transfer and prints either the format string it was
 *  given or, by default and under `-n`, a share of the total. A format that asks
 *  for both numbers (`pv --format '%b/%s '`, bytes moved and total size
 *  separated by a slash) is a fixed denominator; the default share is the
 *  producer's own measurement against a denominator it did not print, so it is
 *  reported as that share and never expanded into invented counts. */
const PAIR = /(\d+)\/(\d+)/g;
const SHARE = /(\d{1,3})%/g;

export const pvProgressAdapter: ProgressAdapter = {
  id: "pv",
  matches(command) {
    return /(?:^|[\s|&;(])pv(?:\s|$)/.test(command);
  },
  read(text) {
    let observation: ProgressObservation | undefined;
    for (const match of text.matchAll(PAIR)) {
      const done = Number(match[1]);
      const total = Number(match[2]);
      if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || total <= 0 || done > total)
        continue;
      observation = {
        scopeId: `bytes:${total}`,
        scopeLabel: "Transfer",
        current: done,
        total,
        totalKind: "fixed",
        unit: "bytes",
      };
    }
    if (observation) return [observation];
    for (const match of text.matchAll(SHARE)) {
      const share = Number(match[1]);
      if (!Number.isSafeInteger(share) || share > 100) continue;
      observation = {
        scopeId: "percent",
        scopeLabel: "Transfer",
        percent: share,
        totalKind: "unknown",
      };
    }
    return observation ? [observation] : [];
  },
};
