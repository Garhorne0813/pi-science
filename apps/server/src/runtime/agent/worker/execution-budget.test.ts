import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  BACKGROUND_CONTEXT,
  type AgentHarnessToolInvocation,
  type NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import { executionBudgetTools } from "./execution-budget.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "execution-budget-"));
  roots.push(cwd);
  await mkdir(join(cwd, ".pi-science"));
  return cwd;
}
function invocation(id: string): AgentHarnessToolInvocation {
  const memo = new Map();
  return {
    operationId: "operation",
    invocationId: id,
    turnId: "turn",
    getMemo: async (key) => memo.get(key),
    setMemo: async (key, value) => {
      memo.set(key, value);
    },
  };
}
const definition = {
  name: "bash",
  label: "Bash",
  description: "Host limit fixture",
  parameters: Type.Object({}),
};
const env = { env: {} as NodeExecutionEnv };
it("enforces a shared durable cap across concurrent tools and worker recreation; replay does not spend twice", async () => {
  const cwd = await workspace();
  const budget = executionBudgetTools(cwd);
  await budget.ledger("operation").configure({ max_seconds: 30, max_executions: 1 });
  let calls = 0;
  const execute = async () => {
    calls++;
    return { content: [{ type: "text" as const, text: "ok" }], details: {} };
  };
  const base = { ...definition, name: "bash", execute };
  const first = invocation("one");
  const results = await Promise.allSettled([
    budget.wrap(base).execute("one", {}, () => {}, env, first, BACKGROUND_CONTEXT),
    budget.wrap(base).execute("two", {}, () => {}, env, invocation("two"), BACKGROUND_CONTEXT),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(calls).toBe(1);
  const restored = executionBudgetTools(cwd);
  await restored.ledger("operation").configure({ max_seconds: 3600, max_executions: 100 });
  await expect(
    restored
      .wrap(base)
      .execute("three", {}, () => {}, env, invocation("three"), BACKGROUND_CONTEXT),
  ).rejects.toThrow("budget exhausted");
  // Reuse the admitted invocation (memo is provided by the durable harness in production).
  if (results[0].status === "fulfilled")
    await restored.wrap(base).execute("one", {}, () => {}, env, first, BACKGROUND_CONTEXT);
});
it("aborts a running tool and refuses new execution after the configured deadline", async () => {
  const cwd = await workspace();
  const budget = executionBudgetTools(cwd);
  await budget.ledger("operation").configure({ max_seconds: 1, max_executions: 5 });
  const tool = budget.wrap({
    ...definition,
    name: "bash",
    execute: async (_id, _params, _update, _ctx, _invocation, context) =>
      new Promise((_resolve, reject) => {
        context.abortSignal!.addEventListener("abort", () => reject(context.abortSignal!.reason), {
          once: true,
        });
      }),
  });
  await expect(
    tool.execute("one", {}, () => {}, env, invocation("one"), BACKGROUND_CONTEXT),
  ).rejects.toThrow("budget exhausted");
  await expect(
    tool.execute("two", {}, () => {}, env, invocation("two"), BACKGROUND_CONTEXT),
  ).rejects.toThrow("budget exhausted");
});

it("passes the remaining hard timeout to notebook kernel execution", async () => {
  const cwd = await workspace();
  const budget = executionBudgetTools(cwd);
  await budget.ledger("operation").configure({ max_seconds: 10, max_executions: 1 });
  let timeout = 0;
  const notebook = budget.wrap({
    ...definition,
    name: "notebook_run",
    execute: async (_id, params) => {
      timeout = (params as { timeout_seconds: number }).timeout_seconds;
      return { content: [], details: {} };
    },
  });
  await notebook.execute(
    "run",
    { timeout_seconds: 600 },
    () => {},
    env,
    invocation("run"),
    BACKGROUND_CONTEXT,
  );
  expect(timeout).toBeGreaterThan(0);
  expect(timeout).toBeLessThanOrEqual(10);
});
it("fails closed on a corrupt saved budget instead of replenishing it", async () => {
  const cwd = await workspace();
  const budget = executionBudgetTools(cwd);
  const { createHash } = await import("node:crypto");
  const { workspaceFile } = await import("../../../storage/persistence.js");
  const path = workspaceFile(
    cwd,
    `execution-budgets/${createHash("sha256").update("operation").digest("hex")}.json`,
  );
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ deadline: 1, maxExecutions: -1, used: 100 }));
  await expect(budget.ledger("operation").configure({ max_seconds: 30 })).rejects.toThrow(
    "refusing to reset",
  );
});

it("shares one persistent research allowance across parent, parallel children, recreation and continuation", async () => {
  const cwd = await workspace();
  const parent = executionBudgetTools(cwd);
  await parent.ledger("operation").configure({ max_seconds: 30, max_executions: 2 }, "study-1");
  const child = executionBudgetTools(cwd, "operation");
  const base = { ...definition, name: "bash", execute: async () => ({ content: [], details: {} }) };
  const results = await Promise.allSettled(
    [child, executionBudgetTools(cwd, "operation"), executionBudgetTools(cwd, "operation")].map(
      (budget, index) =>
        budget
          .wrap(base)
          .execute(
            String(index),
            {},
            () => {},
            env,
            { ...invocation(String(index)), operationId: `child-${index}` },
            BACKGROUND_CONTEXT,
          ),
    ),
  );
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(2);
  const restored = executionBudgetTools(cwd);
  const continuation = { ...invocation("resume"), operationId: "continuation" };
  const status = await restored
    .ledger("continuation")
    .configure({ max_seconds: 3600, max_executions: 100 }, "study-1");
  expect(status).toMatchObject({ used: 2, maxExecutions: 2, remaining_executions: 0 });
  await expect(
    restored.wrap(base).execute("later", {}, () => {}, env, continuation, BACKGROUND_CONTEXT),
  ).rejects.toThrow("budget exhausted");
  await expect(child.ledger("operation").configure({}, "fresh")).rejects.toThrow(
    "Children cannot change",
  );
  await expect(restored.ledger("continuation").configure({}, "fresh")).rejects.toThrow(
    "Cannot change",
  );
});

it("reserves across simultaneous children without refunding failed calls or exceeding the cap", async () => {
  const cwd = await workspace();
  const parent = executionBudgetTools(cwd);
  await parent.ledger("operation").configure({ max_seconds: 30, max_executions: 1 });
  let calls = 0;
  const base = {
    ...definition,
    name: "bash",
    execute: async () => {
      calls++;
      throw new Error("candidate failed");
    },
  };
  const results = await Promise.allSettled(
    ["a", "b"].map((id) =>
      executionBudgetTools(cwd, "operation")
        .wrap(base)
        .execute(
          id,
          {},
          () => {},
          env,
          { ...invocation(id), operationId: `child-${id}` },
          BACKGROUND_CONTEXT,
        ),
    ),
  );
  expect(calls).toBe(1);
  expect(
    results.map((value) => (value.status === "rejected" ? String(value.reason) : "ok")).sort(),
  ).toEqual(["Error: Execution call budget exhausted", "Error: candidate failed"]);
  const status = await parent.ledger("operation").configure({});
  expect(status).toMatchObject({ used: 1, remaining_executions: 0 });
});

it("rejects late scope binding and refuses to recreate a missing inherited budget", async () => {
  const cwd = await workspace();
  const budget = executionBudgetTools(cwd);
  await budget.ledger("operation").configure({ max_executions: 1 });
  await expect(budget.ledger("operation").configure({}, "late")).rejects.toThrow(
    "before the first execution",
  );
  const child = executionBudgetTools(cwd, "missing-owner");
  await expect(child.ledger("operation").configure({})).rejects.toThrow("Missing inherited");
});

it("cancels an operation and restored descendants while a shared research continuation retains its allowance", async () => {
  const cwd = await workspace();
  const first = executionBudgetTools(cwd).ledger("operation-a");
  await first.configure({ max_executions: 5 }, "shared-study");
  const child = await first.createChild("child-a");
  await child.reserve("bash", "child-operation", "one");
  await first.cancelOperation();
  expect(await first.status()).toMatchObject({ cancelled: true, global_used: 1 });
  const restored = executionBudgetTools(cwd, "operation-a", "child-a").ledger("child-operation");
  await expect(restored.reserve("bash", "child-operation", "two")).rejects.toThrow("cancelled");
  await expect(first.createChild("later-child")).rejects.toThrow("cancelled");
  const next = executionBudgetTools(cwd).ledger("operation-b");
  await next.configure({}, "shared-study");
  expect(await next.status()).toMatchObject({
    cancelled: false,
    global_used: 1,
    remaining_executions: 4,
  });
  await next.reserve("bash", "operation-b", "one");
  expect(await next.status()).toMatchObject({ global_used: 2, remaining_executions: 3 });
});

it("limits an inherited worker abort to its subtree", async () => {
  const cwd = await workspace();
  const parent = executionBudgetTools(cwd).ledger("parent");
  const child = await parent.createChild("child");
  const grandchild = await child.createChild("grandchild");
  const sibling = await parent.createChild("sibling");
  await child.cancelOperation();
  expect(await grandchild.status()).toMatchObject({ cancelled: true });
  await sibling.reserve("bash", "sibling", "one");
  expect(await parent.status()).toMatchObject({ cancelled: false, global_used: 1 });
});
