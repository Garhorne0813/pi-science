import { z } from "zod";
import { operatorFetch } from "../network/operator-fetch.js";

export const mcpRuntimePolicySchema = z.object({
  connectorId: z.string().min(1), projectId: z.string().min(1), toolName: z.string().min(1),
  connectorRevision: z.number().int().positive(), settingsRevision: z.number().int().positive(),
}).strict();
export type McpRuntimePolicyRequest = z.infer<typeof mcpRuntimePolicySchema>;

/** Snapshots discover tools; the control plane's database admits each call.
 * Missing/unreachable authority and stale revisions must never fall back to disk. */
export async function authorizeMcpTool(cwd: string, expected: McpRuntimePolicyRequest, signal?: AbortSignal): Promise<"allow" | "ask"> {
  const backend = process.env.PI_SCIENCE_BACKEND_URL;
  if (!backend) throw new Error("MCP policy authority is unavailable; refresh the worker");
  mcpRuntimePolicySchema.parse(expected);
  const url = new URL("/api/mcp/runtime/authorize", backend);
  url.searchParams.set("cwd", cwd);
  const token = process.env.PI_SCIENCE_INTERNAL_TOKEN;
  const response = await operatorFetch(url.href, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "x-pi-science-internal-token": token } : {}) },
    body: JSON.stringify(expected), redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`MCP policy changed or unavailable; refresh the worker (HTTP ${response.status})`);
  return z.object({ decision: z.enum(["allow", "ask"]) }).parse(await response.json()).decision;
}
