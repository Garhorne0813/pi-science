import { useQuery } from "@tanstack/react-query";
import { request, responseError } from "./client/http";
export async function memoryRequest<T>(
  cwd: string | null,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await request(
    `/api/memory${path}${cwd ? `${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}` : ""}`,
    {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(responseError(data, "Memory request failed"));
  return data;
}
export function useMemorySummary(cwd: string) {
  return useQuery({
    queryKey: ["memory", cwd, "summary"],
    queryFn: () =>
      memoryRequest<{ pendingCount: number; enabled: boolean }>(
        cwd,
        "/summary",
      ),
    enabled: !!cwd,
    refetchInterval: 15000,
  });
}
export function useMemorySettings() {
  return useQuery({
    queryKey: ["memory", "settings"],
    queryFn: () =>
      memoryRequest<import("@pi-science/contracts").MemorySettings>(
        null,
        "/settings",
      ),
  });
}
