import { useUiStore } from "../ui/store";

/** Navigate from non-route UI (preview panes and chat cards) while retaining
 * the in-memory reveal request consumed by the Files page. */
export function revealWorkspaceFile(cwd: string, path: string): void {
  useUiStore.getState().revealInFileTree(cwd, path);
  if (typeof window === "undefined") return;
  const url = `/workspace/${encodeURIComponent(cwd)}/files`;
  if (window.location.pathname !== url) window.history.pushState(window.history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}
