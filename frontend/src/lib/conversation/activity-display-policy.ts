import type { ToolCallBlock } from "../../types/thread";
import { selectNarrativeActivity, type PresentedActivity } from "./activity-narrative";

export const MIN_ACTIVITY_VISIBLE_MS = 800;
export const ACTIVITY_SWITCH_DEBOUNCE_MS = 250;

export function selectDisplayedActivity(blocks: ToolCallBlock[]): PresentedActivity | null {
  return selectNarrativeActivity(blocks);
}
