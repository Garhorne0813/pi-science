import { emitterProgressAdapter } from "./control-lines.js";
import type { ProgressAdapter } from "./types.js";

/** Registry order decides which adapter's scope is on screen when several
 *  report at once. The explicit protocol is first because a producer that
 *  measured its own work knows more than a reader of its terminal output. Each
 *  entry can be left out of a collector to switch that source off. */
export const DEFAULT_PROGRESS_ADAPTERS: readonly ProgressAdapter[] = [emitterProgressAdapter];
