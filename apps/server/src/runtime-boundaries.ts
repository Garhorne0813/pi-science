export type RuntimeOwner = "node-control-plane" | "python-scientific-runtime";

export type RouteAvailability = "native" | "compatibility-proxy";

export interface RouteBoundary {
  prefix: string;
  owner: RuntimeOwner;
  availability: RouteAvailability;
}

export const routeBoundaries: readonly RouteBoundary[] = [
  { prefix: "/api/health", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/kernels", owner: "python-scientific-runtime", availability: "compatibility-proxy" },
  { prefix: "/api/notebooks", owner: "python-scientific-runtime", availability: "compatibility-proxy" },
  { prefix: "/api/pdfs", owner: "python-scientific-runtime", availability: "compatibility-proxy" },
  { prefix: "/api/figures", owner: "python-scientific-runtime", availability: "compatibility-proxy" },
  { prefix: "/api/literature", owner: "python-scientific-runtime", availability: "compatibility-proxy" },
  { prefix: "/api/sessions", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/files", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/provenance", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/compute", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/settings", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/workspaces", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/skills", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/runs", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/project-knowledge", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/project-memory", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/artifacts", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/citations", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/mcp", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/jobs", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/endpoints", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/agent-profiles", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/result-reviews", owner: "node-control-plane", availability: "native" },
  { prefix: "/api/bookmarks", owner: "node-control-plane", availability: "native" },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function runtimeOwner(pathname: string): RuntimeOwner {
  return routeBoundaries.find((boundary) => matchesPrefix(pathname, boundary.prefix))?.owner ?? "node-control-plane";
}

export function routeBoundary(pathname: string): RouteBoundary | undefined {
  return routeBoundaries.find((boundary) => matchesPrefix(pathname, boundary.prefix));
}
