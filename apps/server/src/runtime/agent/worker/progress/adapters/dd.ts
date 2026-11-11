import type { ProgressAdapter } from "../types.js";

/** `dd status=progress` reports bytes copied and never a total, so the row gets
 *  a count and no bar. GNU dd writes the same sentence on stderr, rewound with
 *  a carriage return that the harness cleaning removes. */
const COPIED = /(\d+) bytes(?: \([^)]*\))? copied/g;
const SCOPE = "dd:progress";

export const ddProgressAdapter: ProgressAdapter = {
  id: "dd",
  matches(command) {
    return /(?:^|[\s|&;(])dd(?:\s|$)/.test(command) && /\bstatus=progress\b/.test(command);
  },
  read(text) {
    let bytes: number | undefined;
    for (const match of text.matchAll(COPIED)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value >= 0) bytes = value;
    }
    return bytes === undefined
      ? []
      : [
          {
            scopeId: SCOPE,
            scopeLabel: "Copied",
            current: bytes,
            totalKind: "unknown",
            unit: "bytes",
          },
        ];
  },
};
