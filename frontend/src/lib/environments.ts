import { apiRequest } from "./client/api";

export interface EnvironmentRevision {
  environment_id: string;
  revision_id: string;
  display_name: string;
  language: "python" | "r";
  status: "creating" | "ready" | "failed" | "archived";
  packages: string[];
  failure?: { message: string };
}

export interface WorkspaceEnvironment {
  ready: boolean;
  prefix?: string;
  python?: string;
  display_name?: string;
  revision_id?: string;
  manager?: string;
  error?: string;
}

export const environmentsQuery = () => ({
  queryKey: ["environments", "list"] as const,
  queryFn: () => apiRequest<{ environments: EnvironmentRevision[] }>("/api/environments"),
  staleTime: 0,
});

export const workspaceEnvironmentQuery = (cwd: string) => ({
  queryKey: ["environments", "workspace", cwd] as const,
  queryFn: () => apiRequest<WorkspaceEnvironment>(`/api/environments/workspace?cwd=${encodeURIComponent(cwd)}`),
  staleTime: 0,
});
