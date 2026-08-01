/** Artifacts auto-preview — decide which file ref (if any) to open in the
 *  inspector when a live turn completes. Pure logic; the LiveSessionPage
 *  effect handles turn-transition tracking and the actual open. */

import { extOf } from "./artifacts";

/** Extensions safe to auto-open without user intent (plots, reports, tables). */
const AUTO_PREVIEW_EXTS = new Set([
  "png", "jpg", "jpeg", "svg", "gif", "webp", "html", "htm", "md", "csv", "pdf",
]);

/**
 * Pick the last previewable ref from an agent message, or null when nothing
 * qualifies — or when the inspector is already open (never replace what the
 * user is looking at).
 */
export function pickAutoPreviewArtifact(
  refs: string[],
  opts: { inspectorOpen: boolean },
): string | null {
  if (opts.inspectorOpen) return null;
  return refs.findLast((ref) => AUTO_PREVIEW_EXTS.has(extOf(ref))) ?? null;
}
