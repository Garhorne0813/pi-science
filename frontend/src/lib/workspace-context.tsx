/** Single source of truth for the active workspace cwd.
 *  The `:cwd` route param is decoded exactly once, here, and read through the hooks below —
 *  route components must not derive it from `useParams` themselves. */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useParams } from "react-router-dom";

/** `string` inside a workspace route, `null` outside one, `undefined` when no provider is mounted. */
const WorkspaceCwdContext = createContext<string | null | undefined>(undefined);

/** Mounted around the whole route tree (see app/router.tsx) so every route shares one derivation. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const cwd = useMemo(() => (rawCwd ? decodeURIComponent(rawCwd) : null), [rawCwd]);
  return <WorkspaceCwdContext.Provider value={cwd}>{children}</WorkspaceCwdContext.Provider>;
}

/** Decoded workspace cwd, or `null` on the routes that render outside a workspace (`/`, `/settings`, `/skills`). */
export function useWorkspaceCwd(): string | null {
  const cwd = useContext(WorkspaceCwdContext);
  if (cwd === undefined) throw new Error("useWorkspaceCwd must be used inside <WorkspaceProvider>");
  return cwd;
}

/** Decoded workspace cwd for pages that are only routed under `/workspace/:cwd`. */
export function useRequiredWorkspaceCwd(): string {
  const cwd = useWorkspaceCwd();
  if (!cwd) throw new Error("useRequiredWorkspaceCwd used outside a workspace route");
  return cwd;
}
