import type { ProgressAdapter } from "../types.js";
import { ddProgressAdapter } from "./dd.js";
import { pvProgressAdapter } from "./pv.js";
import { rsyncProgressAdapter } from "./rsync.js";
import { tqdmProgressAdapter } from "./tqdm.js";

/** Command-reading adapters, in the order they get to claim the visible scope.
 *  Each one recognizes the command it reads, so a number in another tool's
 *  output is never taken for a progress report. */
export const COMMAND_PROGRESS_ADAPTERS: readonly ProgressAdapter[] = [
  tqdmProgressAdapter,
  pvProgressAdapter,
  rsyncProgressAdapter,
  ddProgressAdapter,
];
