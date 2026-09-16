import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

let media: MediaQueryList | null = null;
function mediaList(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  if (!media) media = window.matchMedia(QUERY);
  return media;
}

function getSnapshot(): boolean {
  return mediaList()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const list = mediaList();
  if (!list) return () => undefined;
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function getServerSnapshot(): boolean { return false; }

/** Subscribes to the OS reduced-motion preference, so flipping the system
 *  setting takes effect immediately — not on the next unrelated re-render.
 *  The single consumer computes the effective motion policy from this, and
 *  every animation family renders from that shared result. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
