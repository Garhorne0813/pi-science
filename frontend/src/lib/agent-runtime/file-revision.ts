/** File-tree revision coordination.
 *
 *  `fileRevision` drives the sidebar tree and the files page to re-read the
 *  workspace after a turn settles. Both the SSE listener (agent_settled /
 *  session.idle) and the REST recovery paths (idle confirmed after a
 *  connection loss) must bump it — but only once per activity generation:
 *  a double bump from the same turn is harmless, yet wasteful, and recovery
 *  of an older session must still bump when no live event did. The key
 *  combines the connection and activity generations plus the active session,
 *  so switching sessions always produces a fresh bump for the new tree. */

import { workspaceFiles } from "../workspace";
import { generations } from "./generations";
import { useRuntimeStore } from "./store";

let lastKey = "";
let lastSession: string | null = null;

export function markWorkspaceFilesChanged(): void {
  const state = useRuntimeStore.getState();
  const key = `${generations.connection}:${generations.activity}`;
  if (key === lastKey && state.activeSessionId === lastSession) return;
  lastKey = key;
  lastSession = state.activeSessionId;
  workspaceFiles.invalidate();
  useRuntimeStore.setState({ fileRevision: (state.fileRevision ?? 0) + 1 });
}
