import { Navigate, useParams } from "react-router-dom";

/** Old Research bookmarks lead to the read-only archives in Run history. */
export function LegacyWorkspaceRedirect() {
  const { cwd = "", "*": path = "" } = useParams();
  return <Navigate replace to={`/workspace/${encodeURIComponent(cwd)}${path === "research" || path.startsWith("research/") ? "/runs?archives=1" : ""}`} />;
}

