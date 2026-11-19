// Highlighting policy shared by the code view and the file inspector.
//
// Measured on the real bundle (highlight.js 11.11.1, dev c93555dc): a 2 MB file
// without a matching grammar goes through highlightAuto, which scans all 35
// bundled grammars and takes 12–33 s on the main thread with 1–2.4 GB of heap;
// a 4.97 MB PDB took 23 s and produced 793k DOM nodes. Plain text of the same
// file renders in milliseconds, so large files are shown unhighlighted.

import type { PreviewKind } from "./artifacts";

/** Roughly 1 MiB of ASCII source. Compared against UTF-16 length to avoid a
 *  second full-size copy of the file just to count bytes. */
export const MAX_HIGHLIGHT_CHARS = 1_000_000;

/** A second guard for files with very short lines (e.g. 5 MB PDB = 61k lines). */
export const MAX_HIGHLIGHT_LINES = 20_000;

/** Auto-detection scans every bundled grammar (35 in the common bundle) and is
 *  measured at ~11x the cost of an explicit grammar, while often guessing wrong
 *  (PDB -> yaml, log -> lua). Files with no declared language get auto-detection
 *  only while short; larger ones are shown as plain text. */
export const MAX_AUTO_CHARS = 20_000;

export function shouldSkipAutoDetect(code: string): boolean {
  return code.length > MAX_AUTO_CHARS;
}

/** True when highlighting this file would block the main thread for seconds. */
export function shouldSkipHighlight(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > MAX_HIGHLIGHT_LINES) return true;
    }
  }
  return false;
}

/** Molecule and genome files have no highlight.js grammar. Auto-detection used
 *  to paint them as yaml/shell (wrong colors) and cost ~11x the time, so their
 *  code tab is always plain text. */
export function codeViewLanguage(kind: PreviewKind, language?: string): string | undefined {
  if (kind === "molecule" || kind === "genome") return "plaintext";
  return language;
}
