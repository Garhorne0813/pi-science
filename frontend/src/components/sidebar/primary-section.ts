import { matchPath } from "react-router-dom";
export type PrimarySection = "projects" | "conversations" | "knowledge" | "research" | "runs";
export function isSettingsRoute(pathname: string): boolean { return pathname === "/settings" || !!matchPath({ path: "/workspace/:cwd/settings", end: true }, pathname); }
export function primarySection(pathname: string, cwd: string | null): PrimarySection | null {
  if (pathname === "/") return "projects";
  if (!cwd || isSettingsRoute(pathname)) return null;
  const root = `/workspace/${encodeURIComponent(cwd)}`;
  if (pathname === root || !!matchPath({ path: `${root}/session/:sessionId`, end: true }, pathname)) return "conversations";
  for (const section of ["knowledge", "research", "runs"] as const) if (pathname === `${root}/${section}`) return section;
  return null;
}
