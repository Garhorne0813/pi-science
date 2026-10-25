import type { PiScienceClient } from "../../client/pi-science-client";

/** Subscription owns this binding; timers read it at execution time. */
export const listenerBinding: { client: PiScienceClient | null; unsubscribe: (() => void) | null } = {
  client: null,
  unsubscribe: null,
};
