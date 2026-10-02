import type { EventEmitter } from "node:events";
import type { PiResult } from "../pi/pi-process.js";

export type RunnerTransport = Pick<EventEmitter, "on" | "once" | "removeAllListeners"> & {
  readonly durablePrompts?: boolean;
  sendCommand(type: string, params?: Record<string, unknown>): Promise<PiResult>;
};
