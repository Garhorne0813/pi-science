import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sandboxCandidate, type SandboxIdentity } from "../agent/worker/sandbox-tool.js";
import { identifyPolicy, workspacePolicy } from "./policy.js";
import { bindRuntimeReadPolicy } from "./read-grants.js";

export const SANDBOX_GRANT_HEADER = "x-pi-science-sandbox-grant";
const bindingSchema = z.object({ cwd: z.string(), sessionId: z.string(), budgetOperationId: z.string(), candidateId: z.string().optional(), delegatedAgent: z.string().optional(), expires: z.number() }).strict();
/** Worker-only adapter signs server-bound identity, never a model-supplied policy. */
export function candidateKernelGrant(identity: SandboxIdentity, operationId: string, secret: string | undefined): string {
  if (!secret || !identity.candidateId) throw new Error("Candidate notebook requires authenticated control-plane policy binding");
  return workerKernelGrant(identity, operationId, secret);
}
export function workerKernelGrant(identity: SandboxIdentity, operationId: string, secret: string): string {
  const binding = bindingSchema.parse({ ...identity, budgetOperationId: identity.budgetOperationId ?? operationId, expires: Date.now() + 600_000 });
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export async function authorizeKernelPolicy(cwd: string, revision: string | undefined, grant: unknown, secret: string | undefined) {
  return bindRuntimeReadPolicy(await authorizedKernelPolicy(cwd, revision, grant, secret));
}

async function authorizedKernelPolicy(cwd: string, revision: string | undefined, grant: unknown, secret: string | undefined) {
  if (grant === undefined) return workspacePolicy(cwd, revision);
  if (typeof grant !== "string" || grant.length > 4096 || !secret) throw new Error("Invalid kernel sandbox authorization");
  const [payload, signature, extra] = grant.split(".");
  const expected = createHmac("sha256", secret).update(payload ?? "").digest();
  const actual = Buffer.from(signature ?? "", "base64url");
  if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid kernel sandbox authorization");
  const binding = bindingSchema.parse(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")));
  if (binding.cwd !== cwd || binding.expires <= Date.now()) throw new Error("Expired or mismatched kernel sandbox authorization");
  if (!binding.candidateId) {
    if (binding.delegatedAgent === "auto-research/experimenter") throw new Error("Candidate notebook requires a bound candidate_id");
    return identifyPolicy({ ...await workspacePolicy(cwd, revision), owner: binding.sessionId });
  }
  const candidate = await sandboxCandidate(binding, binding.budgetOperationId, binding.candidateId);
  return identifyPolicy({ mode: "required", scope: "candidate", researchId: candidate.researchId, owner: binding.sessionId, cwd: candidate.work, readPaths: [candidate.input, candidate.work], writePaths: [candidate.work], denyPaths: [], network: { mode: "none" }, ...(revision ? { environmentRevision: revision } : {}) });
}
