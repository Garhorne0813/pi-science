import { assertApprovalDispatchAvailable } from "./approval-transition.js";
import { readSessionApproval } from "./session-approval.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { executionGrantPolicy } from "./execution-grants.js";
import { type SandboxIdentity } from "../agent/worker/confined-read-tool.js";
import { identifyPolicy, workspacePolicy } from "./policy.js";
import { bindRuntimeReadPolicy } from "./read-grants.js";

export const SANDBOX_GRANT_HEADER = "x-pi-science-sandbox-grant";
const bindingSchema = z
  .object({
    cwd: z.string(),
    sessionId: z.string(),
    budgetOperationId: z.string(),
    candidateId: z.string().optional(),
    executionGrantId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    budgetNodeId: z.string().optional(),
    executionScope: z.enum(["workspace", "confined", "candidate"]).optional(),
    delegatedAgent: z.string().optional(),
    approvalRevision: z.number().int().nonnegative().optional(),
    expires: z.number(),
  })
  .strict();
/** Worker-only adapter signs server-bound identity, never a model-supplied policy. */
export async function confinedKernelGrant(
  identity: SandboxIdentity,
  operationId: string,
  secret: string | undefined,
): Promise<string> {
  if (!secret || !identity.executionGrantId)
    throw new Error("Candidate notebook requires authenticated control-plane policy binding");
  return workerKernelGrant(identity, operationId, secret);
}
export async function workerKernelGrant(
  identity: SandboxIdentity,
  operationId: string,
  secret: string,
): Promise<string> {
  const approvalRevision =
    !identity.executionGrantId &&
    !identity.delegatedAgent &&
    !identity.candidateId &&
    identity.executionScope !== "confined" &&
    identity.executionScope !== "candidate"
      ? (await readSessionApproval(identity.cwd, identity.sessionId)).revision
      : undefined;
  const binding = bindingSchema.parse({
    ...identity,
    approvalRevision,
    executionScope: identity.executionGrantId
      ? "confined"
      : identity.candidateId
        ? "candidate"
        : (identity.executionScope ?? "workspace"),
    budgetOperationId: identity.budgetOperationId ?? operationId,
    expires: Date.now() + 600_000,
  });
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export async function authorizeKernelPolicy(
  cwd: string,
  revision: string | undefined,
  grant: unknown,
  secret: string | undefined,
  tool?: string,
) {
  return bindRuntimeReadPolicy(await authorizedKernelPolicy(cwd, revision, grant, secret, tool));
}

async function authorizedKernelPolicy(
  cwd: string,
  revision: string | undefined,
  grant: unknown,
  secret: string | undefined,
  tool?: string,
) {
  if (grant === undefined) return workspacePolicy(cwd, revision);
  if (typeof grant !== "string" || grant.length > 4096 || !secret)
    throw new Error("Invalid kernel sandbox authorization");
  const [payload, signature, extra] = grant.split(".");
  const expected = createHmac("sha256", secret)
    .update(payload ?? "")
    .digest();
  const actual = Buffer.from(signature ?? "", "base64url");
  if (
    extra !== undefined ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    throw new Error("Invalid kernel sandbox authorization");
  const binding = bindingSchema.parse(
    JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
  );
  if (binding.cwd !== cwd || binding.expires <= Date.now())
    throw new Error("Expired or mismatched kernel sandbox authorization");
  if (binding.delegatedAgent && !binding.executionScope)
    throw new Error("Legacy delegated kernel authorization requires a fresh scope binding");
  assertApprovalDispatchAvailable(cwd, binding.sessionId);
  if (binding.executionGrantId) return executionGrantPolicy(binding, revision, tool);
  if (
    binding.candidateId ||
    binding.executionScope === "candidate" ||
    binding.executionScope === "confined"
  )
    throw new Error(
      "Candidate notebook requires a bound candidate_id and server-bound execution grant; migrate the task binding",
    );
  if (
    !binding.delegatedAgent &&
    (binding.approvalRevision === undefined ||
      (await readSessionApproval(cwd, binding.sessionId)).revision !== binding.approvalRevision)
  )
    throw new Error("Kernel approval revision changed; request a fresh capability");
  return identifyPolicy({
    ...(await workspacePolicy(
      cwd,
      revision,
      "analysis",
      binding.delegatedAgent ? undefined : binding.sessionId,
    )),
    owner: binding.sessionId,
  });
}
