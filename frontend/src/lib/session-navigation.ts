export interface SessionLocation {
  pathname: string;
  search: string;
  hash: string;
}

export function replacementSessionUrl(location: SessionLocation, oldId: string, newId: string): string | null {
  const oldSuffix = `/session/${encodeURIComponent(oldId)}`;
  if (!location.pathname.endsWith(oldSuffix)) return null;
  return `${location.pathname.slice(0, -oldSuffix.length)}/session/${encodeURIComponent(newId)}${location.search}${location.hash}`;
}

/** Browser-only route adapter. Conversation state remains independent of React Router. */
export function replaceBrowserSessionRoute(oldId: string, newId: string): void {
  if (typeof window === "undefined") return;
  const next = replacementSessionUrl(window.location, oldId, newId);
  if (next) window.history.replaceState(window.history.state, "", next);
}
