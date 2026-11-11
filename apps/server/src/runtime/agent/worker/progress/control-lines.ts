import type { ProgressObservation } from "./types.js";

/** A producer writes one control record per line, at column zero. The token is
 *  long and ends a sentence rarely, so ordinary output keeps its text. */
export const TOOL_PROGRESS_SENTINEL = "<<pi-progress>>";
/** A control record is small. A longer line is ordinary output that starts with
 *  the token by accident, or a producer that lost its newline. */
export const PROGRESS_RECORD_LIMIT_BYTES = 512;

/** Whole lines only. A record that has no newline yet is still being written,
 *  and half a JSON object is not a measurement. */
export function controlLines(text: string): { visible: string; records: string[] } {
  let visible = "";
  const records: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const complete = index < lines.length - 1;
    if (!line.startsWith(TOOL_PROGRESS_SENTINEL)) {
      visible += line + (complete ? "\n" : "");
      continue;
    }
    if (!complete || Buffer.byteLength(line, "utf8") > PROGRESS_RECORD_LIMIT_BYTES) continue;
    if (line[TOOL_PROGRESS_SENTINEL.length] !== " ") continue;
    records.push(line.slice(TOOL_PROGRESS_SENTINEL.length + 1));
  }
  return { visible, records };
}

/** The emitter protocol. It is the only adapter allowed to read control lines,
 *  and it is written in the producer's own JSON so no language has to link
 *  against this package. */
export const emitterProgressAdapter = {
  id: "emitter",
  readsControlLines: true,
  read(text: string): ProgressObservation[] {
    return controlLines(text).records.flatMap((record) => {
      let value: unknown;
      try {
        value = JSON.parse(record);
      } catch {
        return [];
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const raw = value as Record<string, unknown>;
      const scopeId = raw.scopeId;
      const scopeLabel = raw.scopeLabel;
      if (typeof scopeId !== "string" || typeof scopeLabel !== "string") return [];
      return [
        {
          scopeId,
          scopeLabel,
          ...(typeof raw.current === "number" ? { current: raw.current } : {}),
          ...(typeof raw.total === "number" ? { total: raw.total } : {}),
          ...(raw.totalKind === "fixed" ||
          raw.totalKind === "reestimated" ||
          raw.totalKind === "unknown"
            ? { totalKind: raw.totalKind }
            : {}),
          ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
          ...(typeof raw.phase === "string" ? { phase: raw.phase } : {}),
          ...(typeof raw.label === "string" ? { label: raw.label } : {}),
          ...(raw.indeterminate === true ? { indeterminate: raw.indeterminate } : {}),
        },
      ];
    });
  },
} as const;
