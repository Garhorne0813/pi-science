import { normalizeToolProgress, type ToolProgressV1 } from "@pi-science/contracts";
import { controlLines, TOOL_PROGRESS_SENTINEL } from "./progress/control-lines.js";

export { TOOL_PROGRESS_SENTINEL };

/** Control records only. Used where the output is text and no collector is
 *  running, such as an error message rebuilt after the call failed. */
export function readToolProgressStream(text: string): { text: string; progress?: ToolProgressV1 } {
  const { visible, records } = controlLines(text);
  let progress: ToolProgressV1 | undefined;
  for (const record of records) {
    try {
      progress = normalizeToolProgress(JSON.parse(record)) ?? progress;
    } catch {
      /* ordinary text that began with the token */
    }
  }
  return { text: visible, ...(progress ? { progress } : {}) };
}
