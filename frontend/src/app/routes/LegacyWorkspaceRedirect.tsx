import { Navigate, useParams } from "react-router-dom";

/** Old Research bookmarks lead to the read-only archive in Knowledge. */
export function LegacyWorkspaceRedirect() {
  const { cwd = "", "*": path = "" } = useParams();
  return <Navigate replace to={`/workspace/${encodeURIComponent(cwd)}${path === "research" || path.startsWith("research/") ? "/knowledge?tab=research" : ""}`} />;
}

