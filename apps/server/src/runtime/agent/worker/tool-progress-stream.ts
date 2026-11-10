import { normalizeToolProgress, type ToolProgressV1 } from "@pi-science/contracts";

export const TOOL_PROGRESS_SENTINEL = "<<pi-progress>>";

export function readToolProgressStream(text: string): { text: string; progress?: ToolProgressV1 } {
  let visible = "";
  let progress: ToolProgressV1 | undefined;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const complete = i < lines.length - 1;
    if (!line.startsWith(TOOL_PROGRESS_SENTINEL)) { visible += line + (complete ? "\n" : ""); continue; }
    if (!complete || Buffer.byteLength(line, "utf8") > 512 || line[TOOL_PROGRESS_SENTINEL.length] !== " ") continue;
    try { progress = normalizeToolProgress(JSON.parse(line.slice(TOOL_PROGRESS_SENTINEL.length + 1))) ?? progress; } catch {}
  }
  return { text: visible, ...(progress ? { progress } : {}) };
}
