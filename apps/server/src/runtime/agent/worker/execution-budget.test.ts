import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type AgentHarnessToolInvocation, type NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { executionBudgetTools } from "./execution-budget.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function workspace() { const cwd = await mkdtemp(join(tmpdir(), "execution-budget-")); roots.push(cwd); await mkdir(join(cwd, ".pi-science")); return cwd; }
function invocation(id: string): AgentHarnessToolInvocation { const memo = new Map(); return { operationId: "operation", invocationId: id, turnId: "turn", getMemo: async (key) => memo.get(key), setMemo: async (key, value) => { memo.set(key, value); } }; }
const env = { env: {} as NodeExecutionEnv };
it("enforces a shared durable cap across concurrent tools and worker recreation; replay does not spend twice", async () => {
  const cwd = await workspace(); const budget = executionBudgetTools(cwd);
  await budget.tool.execute("setup", { max_seconds: 30, max_executions: 1 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  let calls = 0; const execute = async () => { calls++; return { content: [{ type: "text" as const, text: "ok" }], details: {} }; };
  const base = { ...budget.tool, name: "bash", execute };
  const first = invocation("one");
  const results = await Promise.allSettled([budget.wrap(base).execute("one", {}, () => {}, env, first, BACKGROUND_CONTEXT), budget.wrap(base).execute("two", {}, () => {}, env, invocation("two"), BACKGROUND_CONTEXT)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(calls).toBe(1);
  const restored = executionBudgetTools(cwd);
  await restored.tool.execute("expand", { max_seconds: 3600, max_executions: 100 }, () => {}, env, invocation("expand"), BACKGROUND_CONTEXT);
  await expect(restored.wrap(base).execute("three", {}, () => {}, env, invocation("three"), BACKGROUND_CONTEXT)).rejects.toThrow("budget exhausted");
  // Reuse the admitted invocation (memo is provided by the durable harness in production).
  if (results[0].status === "fulfilled") await restored.wrap(base).execute("one", {}, () => {}, env, first, BACKGROUND_CONTEXT);
});
it("aborts a running tool and refuses new execution after the configured deadline", async () => {
  const cwd = await workspace(); const budget = executionBudgetTools(cwd);
  await budget.tool.execute("setup", { max_seconds: 1, max_executions: 5 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  const tool = budget.wrap({ ...budget.tool, name: "bash", execute: async (_id, _params, _update, _ctx, _invocation, context) => new Promise((_resolve, reject) => { context.abortSignal!.addEventListener("abort", () => reject(context.abortSignal!.reason), { once: true }); }) });
  await expect(tool.execute("one", {}, () => {}, env, invocation("one"), BACKGROUND_CONTEXT)).rejects.toThrow("budget exhausted");
  await expect(tool.execute("two", {}, () => {}, env, invocation("two"), BACKGROUND_CONTEXT)).rejects.toThrow("budget exhausted");
});

it("passes the remaining hard timeout to notebook kernel execution", async () => {
  const cwd = await workspace(); const budget = executionBudgetTools(cwd);
  await budget.tool.execute("setup", { max_seconds: 10, max_executions: 1 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  let timeout = 0;
  const notebook = budget.wrap({ ...budget.tool, name: "notebook_run", execute: async (_id, params) => { timeout = (params as { timeout_seconds: number }).timeout_seconds; return { content: [], details: {} }; } });
  await notebook.execute("run", { timeout_seconds: 600 }, () => {}, env, invocation("run"), BACKGROUND_CONTEXT);
  expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(10);
});
it("fails closed on a corrupt saved budget instead of replenishing it", async () => {
  const cwd = await workspace(); const budget = executionBudgetTools(cwd);
  const { createHash } = await import("node:crypto"); const { workspaceFile } = await import("../../../storage/persistence.js");
  const path = workspaceFile(cwd, `execution-budgets/${createHash("sha256").update("operation").digest("hex")}.json`);
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify({ deadline: 1, maxExecutions: -1, used: 100 }));
  await expect(budget.tool.execute("setup", { max_seconds: 30 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT)).rejects.toThrow("refusing to reset");
});

it("shares one persistent research allowance across parent, parallel children, recreation and continuation", async () => {
  const cwd = await workspace(); const parent = executionBudgetTools(cwd);
  await parent.tool.execute("setup", { research_id: "study-1", max_seconds: 30, max_executions: 2 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  const child = executionBudgetTools(cwd, "operation");
  const base = { ...parent.tool, name: "bash", execute: async () => ({ content: [], details: {} }) };
  const results = await Promise.allSettled([child, executionBudgetTools(cwd, "operation"), executionBudgetTools(cwd, "operation")].map((budget, index) =>
    budget.wrap(base).execute(String(index), {}, () => {}, env, { ...invocation(String(index)), operationId: `child-${index}` }, BACKGROUND_CONTEXT)));
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(2);
  const restored = executionBudgetTools(cwd);
  const continuation = { ...invocation("resume"), operationId: "continuation" };
  const status = await restored.tool.execute("resume", { research_id: "study-1", max_seconds: 3600, max_executions: 100 }, () => {}, env, continuation, BACKGROUND_CONTEXT);
  expect(status.details).toMatchObject({ used: 2, maxExecutions: 2, remaining_executions: 0 });
  await expect(restored.wrap(base).execute("later", {}, () => {}, env, continuation, BACKGROUND_CONTEXT)).rejects.toThrow("budget exhausted");
  await expect(child.tool.execute("scope", { research_id: "fresh" }, () => {}, env, invocation("scope"), BACKGROUND_CONTEXT)).rejects.toThrow("Children cannot change");
  await expect(restored.tool.execute("scope", { research_id: "fresh" }, () => {}, env, continuation, BACKGROUND_CONTEXT)).rejects.toThrow("Cannot change");
});

it("reserves across simultaneous children without refunding failed calls or exceeding the cap", async () => {
  const cwd = await workspace(); const parent = executionBudgetTools(cwd);
  await parent.tool.execute("setup", { max_seconds: 30, max_executions: 1 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  let calls = 0;
  const base = { ...parent.tool, name: "bash", execute: async () => { calls++; throw new Error("candidate failed"); } };
  const results = await Promise.allSettled(["a", "b"].map((id) => executionBudgetTools(cwd, "operation").wrap(base).execute(id, {}, () => {}, env,
    { ...invocation(id), operationId: `child-${id}` }, BACKGROUND_CONTEXT)));
  expect(calls).toBe(1);
  expect(results.map((value) => value.status === "rejected" ? String(value.reason) : "ok").sort()).toEqual(["Error: Execution call budget exhausted", "Error: candidate failed"]);
  const status = await parent.tool.execute("inspect", {}, () => {}, env, invocation("inspect"), BACKGROUND_CONTEXT);
  expect(status.details).toMatchObject({ used: 1, remaining_executions: 0 });
});

it("rejects late scope binding and refuses to recreate a missing inherited budget", async () => {
  const cwd = await workspace(); const budget = executionBudgetTools(cwd);
  await budget.tool.execute("setup", { max_executions: 1 }, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT);
  await expect(budget.tool.execute("bind", { research_id: "late" }, () => {}, env, invocation("bind"), BACKGROUND_CONTEXT)).rejects.toThrow("before the first execution");
  const child = executionBudgetTools(cwd, "missing-owner");
  await expect(child.tool.execute("setup", {}, () => {}, env, invocation("setup"), BACKGROUND_CONTEXT)).rejects.toThrow("Missing inherited");
});
