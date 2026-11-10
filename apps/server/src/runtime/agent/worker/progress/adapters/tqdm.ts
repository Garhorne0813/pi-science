import type { ProgressAdapter, ProgressObservation } from "../types.js";

/** tqdm writes its bar to stderr and rewrites the same line, so the harness's
 *  control-byte cleaning glues the updates into one long run of text. Each
 *  record still carries the library's own counter as `n/total`, which is a
 *  measurement rather than a percentage restated from prose.
 *
 *  The record shape is specific enough to be read without knowing which
 *  program produced it, which is what lets a run through pytest, snakemake or
 *  uv light the same bar as a bare script. */
const RECORD = /(\d+)%\|[^|\n]*\|\s*(\d+)\/(\d+)\s*\[([^\]\n]*)\]/g;
/** `3it [00:02, 1.4it/s]` is the unknown-total form: a count and no denominator. */
const COUNT_ONLY = /\b(\d+)it \[([^\]\n]*)\]/g;
const RATE = /(?:it\/s|s\/it)/;

export const tqdmProgressAdapter: ProgressAdapter = {
  id: "tqdm",
  read(text) {
    const observations: ProgressObservation[] = [];
    for (const match of text.matchAll(RECORD)) {
      const [, , current, total, suffix] = match;
      if (!RATE.test(suffix ?? "")) continue;
      const done = Number(current);
      const size = Number(total);
      if (!Number.isSafeInteger(done) || !Number.isSafeInteger(size) || size <= 0 || done > size)
        continue;
      observations.push({
        scopeId: `bar:${size}`,
        scopeLabel: description(text, match.index) ?? "Progress",
        current: done,
        total: size,
        totalKind: "fixed",
        unit: "items",
      });
    }
    if (observations.length > 0) return observations;
    for (const match of text.matchAll(COUNT_ONLY)) {
      const done = Number(match[1]);
      if (!RATE.test(match[2] ?? "") || !Number.isSafeInteger(done) || done < 0) continue;
      observations.push({
        scopeId: "count",
        scopeLabel: "Progress",
        current: done,
        totalKind: "unknown",
        unit: "items",
      });
    }
    return observations;
  },
};

/** A bar's description is the text written just before its percentage, after
 *  the last record or line boundary. Anything else on that run of text belongs
 *  to an earlier record, so it is not a label for this one. */
function description(text: string, index: number): string | undefined {
  const start = Math.max(text.lastIndexOf("]", index), text.lastIndexOf("\n", index)) + 1;
  const prefix = text.slice(start, index).trim().replace(/:\s*$/, "");
  return prefix && !/\d/.test(prefix) && !prefix.includes("|") && prefix.length <= 100
    ? prefix
    : undefined;
}
