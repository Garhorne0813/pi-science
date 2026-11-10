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
/** `3it [00:02, 1.4it/s]` is the unknown-total form: a count and no denominator.
 *  The unit is the caller's own word, so it is read rather than assumed. */
const COUNT_ONLY = /\b(\d+)([A-Za-z][\w-]*)\s*\[([^\]\n]*)\]/g;
/** A suffix is a progress field only when it carries a rate — `<number>unit/s`
 *  or `<number>s/unit`. tqdm prints whatever unit the caller set, so `file/s`
 *  and `s/it` must read the same as its default `it/s`; the rate is what
 *  separates a bar suffix from any other bracket in the output. */
const RATE =
  /(?:\d+(?:\.\d+)?|\?)\s*([A-Za-z][\w-]*)\/s|(?:\d+(?:\.\d+)?|\?)\s*s\/([A-Za-z][\w-]*)/;

/** The unit a rate names: `2.00file/s` → `file`, `0.50s/it` → `it`. */
function rateUnit(suffix: string): string | undefined {
  const match = RATE.exec(suffix);
  return match?.[1] ?? match?.[2];
}

/** `it` is tqdm's abbreviation for its default unit, and the row reads it as a
 *  noun; a word the caller chose is shown as written. */
function displayUnit(unit: string | undefined): string {
  return unit === undefined || unit === "it" ? "items" : unit;
}

export const tqdmProgressAdapter: ProgressAdapter = {
  id: "tqdm",
  read(text) {
    const observations: ProgressObservation[] = [];
    for (const match of text.matchAll(RECORD)) {
      const [, , current, total, suffix = ""] = match;
      if (!RATE.test(suffix)) continue;
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
        unit: displayUnit(rateUnit(suffix)),
      });
    }
    if (observations.length > 0) return observations;
    for (const match of text.matchAll(COUNT_ONLY)) {
      const done = Number(match[1]);
      const suffix = match[3] ?? "";
      if (!RATE.test(suffix) || !Number.isSafeInteger(done) || done < 0) continue;
      observations.push({
        scopeId: "count",
        scopeLabel: "Progress",
        current: done,
        totalKind: "unknown",
        unit: displayUnit(match[2]),
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
