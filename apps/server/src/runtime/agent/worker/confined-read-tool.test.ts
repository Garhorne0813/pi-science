import * as grants from "../../sandbox/execution-grants.js";
import { sandboxCandidate } from "../../../skill-adapters/legacy-auto-research.js";
import { createExecutionGrant } from "../../sandbox/execution-grants.js";
import { workspacePolicy } from "../../sandbox/policy.js";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  BACKGROUND_CONTEXT,
  type AgentHarnessToolInvocation,
  type NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import { confinedReadTool, type SandboxIdentity } from "./confined-read-tool.js";
import { Type } from "@earendil-works/pi-ai";
import { executionBudgetTools } from "./execution-budget.js";
const roots: string[] = [];
const definition = {
  name: "read",
  label: "Read",
  description: "Read fixture",
  parameters: Type.Object({ path: Type.String() }),
};
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const env = { env: {} as NodeExecutionEnv };
function invocation(id: string): AgentHarnessToolInvocation {
  const memo = new Map();
  return {
    operationId: "owner",
    invocationId: id,
    turnId: "turn",
    getMemo: async (key) => memo.get(key),
    setMemo: async (key, value) => {
      memo.set(key, value);
    },
  };
}
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "sandbox-[tool]-")));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi-science"));
  const directory = join(cwd, "research/study-1/candidates/candidate-001");
  await mkdir(join(directory, "input"), { recursive: true });
  await mkdir(join(directory, "work"));
  const budget = executionBudgetTools(cwd);
  await budget.ledger("owner").configure({ max_seconds: 120, max_executions: 30 }, "study-1");
  const home = await mkdtemp(join(tmpdir(), "grant-home-"));
  roots.push(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
  const identity: SandboxIdentity = {
    cwd,
    sessionId: "session",
    budgetOperationId: "owner",
    budgetNodeId: "session",
    delegatedAgent: "optimizer",
    executionScope: "candidate",
    candidateId: "candidate-001",
  };
  const { ExecutionBudgetLedger } = await import("../../executions/execution-budget.js");
  const grantBudget = await new ExecutionBudgetLedger(cwd, "owner", true).createChild("session");
  identity.executionGrantId = await createExecutionGrant({
    workspace: cwd,
    workerKey: identity.sessionId,
    budgetOwner: "owner",
    deadline: (await grantBudget.status()).deadline,
    tools: ["read", "bash", "notebook_read", "notebook_run"],
    selection: {
      cwd: join(directory, "work"),
      read_paths: [join(directory, "input")],
      write_paths: [join(directory, "work")],
    },
    parentPolicy: await workspacePolicy(cwd),
  });
  return { cwd, directory, budget, identity };
}
it("rejects candidate symlinks, workspace aliases, input hard links and special output links", async () => {
  const { identity, cwd, directory } = await fixture();
  const alias = join(cwd, "alias");
  await symlink(directory, alias);
  await expect(
    sandboxCandidate({ ...identity, cwd: alias }, "owner", "candidate-001"),
  ).rejects.toThrow();
  await writeFile(join(cwd, "secret"), "SECRET");
  await link(join(cwd, "secret"), join(directory, "input/linked"));
  await expect(sandboxCandidate(identity, "owner", "candidate-001")).rejects.toThrow("links");
  await rm(join(directory, "input/linked"));
  await symlink(join(cwd, "secret"), join(directory, "work/linked"));
  await expect(sandboxCandidate(identity, "owner", "candidate-001")).rejects.toThrow("links");
});
it("restricts the assigned child's read tool to regular candidate files", async () => {
  const { identity, directory } = await fixture();
  const read = confinedReadTool(
    {
      ...definition,
      name: "read",
      execute: async () => ({ content: [], details: { allowed: true } }),
    },
    identity,
  );
  const call = (path: string) =>
    read.execute("read", { path }, () => {}, env, invocation("read"), BACKGROUND_CONTEXT);
  await expect(call("research/study-1/evaluation.yaml")).rejects.toThrow("outside");
  await writeFile(join(directory, "input/data.txt"), "data");
  expect((await call(join(directory, "input/data.txt"))).details).toEqual({ allowed: true });
});
it.skipIf(process.platform !== "linux")(
  "keeps an authorized read pinned when an idle kernel swaps its path for an evaluator link",
  async () => {
    const { identity, directory, cwd } = await fixture();
    const path = join(directory, "work/read.txt");
    const secret = join(cwd, "research/study-1/secret.txt");
    await writeFile(path, "approved");
    await writeFile(secret, "EVALUATOR SECRET");
    const original = {
      ...definition,
      name: "read",
      async execute(
        _id: string,
        _params: unknown,
        _update: unknown,
        ctx: { env: NodeExecutionEnv },
      ) {
        await rm(path);
        await symlink(secret, path);
        const read = await ctx.env.readBinaryFile(path, BACKGROUND_CONTEXT);
        if (!read.ok) throw read.error;
        return {
          content: [{ type: "text" as const, text: Buffer.from(read.value).toString("utf8") }],
          details: {},
        };
      },
    };
    const result = await confinedReadTool(original, identity).execute(
      "read",
      { path },
      () => {},
      env,
      invocation("read"),
      BACKGROUND_CONTEXT,
    );
    expect(result.content).toEqual([{ type: "text", text: "approved" }]);
  },
);
it("refuses unbound Experimenter reads", async () => {
  const { identity } = await fixture();
  const execute = vi.fn();
  const original = { ...definition, name: "read", execute };
  const read = confinedReadTool(original, {
    ...identity,
    candidateId: undefined,
    executionGrantId: undefined,
  });
  for (const path of [
    "research/study-1/evaluation.yaml",
    "research/study-1/evaluator/hidden.json",
    "research/study-1/candidates/candidate-002/work/data.txt",
  ])
    await expect(
      read.execute("read", { path }, () => {}, env, invocation("read"), BACKGROUND_CONTEXT),
    ).rejects.toThrow("bound candidate_id");
  expect(execute).not.toHaveBeenCalled();
  expect(
    confinedReadTool(original, {
      ...identity,
      delegatedAgent: "auditor",
      executionScope: "workspace",
      candidateId: undefined,
      executionGrantId: undefined,
    }),
  ).toBe(original);
});

it("uses protection discovered after the initial authorization, inside the read lock", async () => {
  const { identity, directory } = await fixture();
  const path = join(directory, "work/credentials.json");
  const authorize = grants.executionGrantPolicy;
  let checks = 0;
  vi.spyOn(grants, "executionGrantPolicy").mockImplementation(async (...args) => {
    const policy = await authorize(...args);
    // A file appears after the first policy snapshot and before the locked check.
    if (++checks === 1) await writeFile(path, "PRIVATE CREDENTIAL");
    return policy;
  });
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const read = confinedReadTool({ ...definition, name: "read", execute }, identity);
  await expect(
    read.execute("read", { path }, () => {}, env, invocation("read"), BACKGROUND_CONTEXT),
  ).rejects.toThrow("outside");
  expect(checks).toBe(2);
  expect(execute).not.toHaveBeenCalled();
});
