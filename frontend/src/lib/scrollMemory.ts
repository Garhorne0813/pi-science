import { useEffect, useRef } from "react";

/** Retain a stable ref across renders, keyed by a session-unique id.
 *  In the Tauri version of open-science this would restore scroll position;
 *  in the web version it is a noop, kept to avoid changing the call sites. */
export function useScrollMemory(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { /* noop in web version */ }, [key]);
  return ref;
}
