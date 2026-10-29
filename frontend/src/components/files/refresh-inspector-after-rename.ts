import { pinnedFileInspector } from "../../lib/artifacts";
import { useUiStore } from "../../lib/ui";

/** A rename moves the file out from under the inspector, which then reports a
 *  missing file. Reopen on the new path so an open preview survives the rename. */
export function refreshInspectorAfterRename(source: string, target: string, cwd: string): void {
  const openPath = (useUiStore.getState().inspectorData as { path?: string } | null)?.path;
  if (!openPath || !(openPath === source || openPath.startsWith(`${source}/`))) return;
  const next = `${target}${openPath.slice(source.length)}`;
  void pinnedFileInspector(next, undefined, undefined, cwd)
    .then((inspector) => useUiStore.getState().openInspector(inspector))
    .catch(() => undefined);
}
