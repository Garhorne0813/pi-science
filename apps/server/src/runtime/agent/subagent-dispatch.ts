import {
  createExecutionGrant,
  executionGrantPolicy,
  executionSelectionSchema,
} from "../sandbox/execution-grants.js";
import { workspacePolicy } from "../sandbox/policy.js";
import { sandboxCandidate as legacyResearchBinding } from "../../skill-adapters/legacy-auto-research.js";
import {
  AGENT_NAME_PATTERN,
  resolveAgentDefinition,
  childToolAllowance,
  childExecutionScope,
  ScopeMigrationRequiredError,
} from "./agent-definitions.js";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import {
  readJson,
  withFileWriteLock,
  workspaceFile,
  writeJsonAtomic,
} from "../../storage/persistence.js";
import { createHash } from "node:crypto";
import { ExecutionBudgetLedger, budgetLimitsSchema } from "../executions/execution-budget.js";
import { openHiddenTask, runHiddenPrompt } from "./hidden-agent-task.js";
import type { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import type { AgentRuntimeStartOptions } from "./worker/protocol.js";
import type { ExecutionScope, RuntimeEvent } from "./agent-runtime-types.js";

const task = z
  .object({
    sandbox: executionSelectionSchema.optional(),
    agent: z.string().regex(AGENT_NAME_PATTERN),
    task: z.string().min(1).max(200_000),
    candidate_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .optional(),
    tools: z.array(z.string()).max(500).optional(),
    budget: budgetLimitsSchema.optional(),
  })
  .strict();
const wait = { wait_seconds: z.number().finite().min(0).max(600).optional() };
const paramsSchema = z.union([
  task.extend(wait).strict(),
  z.object({ chain: z.array(task).min(1).max(8), ...wait }).strict(),
  z.object({ tasks: z.array(task).min(1).max(4), ...wait }).strict(),
]);
const controlSchema = z
  .object({
    action: z.enum(["list", "status", "collect", "stop"]),
    task_id: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ...wait,
  })
  .strict();
const recordSchema = z
  .object({
    task_id: z.string(),
    owner: z.string(),
    operationId: z.string(),
    invocationId: z.string(),
    budget_owner: z.string(),
    params: paramsSchema,
    executionScopes: z.array(z.enum(["workspace", "confined", "candidate"])).optional(),
    deadline: z.number(),
    status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
    error_code: z.literal("scope_migration_required").optional(),
  })
  .strict();
type TaskRecord = z.infer<typeof recordSchema>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Authenticated ownership is the session IPC channel, never model-supplied IDs. */
export function bindSubagentDispatch(
  manager: AgentRuntimeManager,
  parent: AgentCoreRuntimeClient,
  options: AgentRuntimeStartOptions,
): { (): Promise<void>; isBusy: () => boolean } {
  const pending = new Set<Promise<unknown>>();
  const track = (value: Promise<unknown>) => {
    pending.add(value);
    const done = () => pending.delete(value);
    void value.then(done, done);
  };
  const active = new Map<string, Set<string>>();
  const cancelled = new Set<string>();
  const requests = new Map<string, string>();
  const waits = new Map<string, AbortController>();
  const jobs = new Map<string, Promise<Record<string, unknown>>>();
  const pathFor = (id: string) =>
    workspaceFile(options.cwd, `agent-tasks/${digest(parent.sessionId)}/${id}.json`);
  const load = async (id: string): Promise<TaskRecord> => {
    const record = recordSchema.parse(await readJson(pathFor(id), null));
    if (record.owner !== parent.sessionId || record.task_id !== id)
      throw new Error("Subagent task does not belong to this session");
    return record;
  };
  const list = async () => {
    const names = await readdir(
      workspaceFile(options.cwd, `agent-tasks/${digest(parent.sessionId)}`),
    ).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const values: TaskRecord[] = [];
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const value = recordSchema.parse(await readJson(pathFor(name.slice(0, -5)), null));
      if (value.owner === parent.sessionId) values.push(value);
    }
    return values;
  };
  const cancel = async (id: string) => {
    cancelled.add(id);
    try {
      await withFileWriteLock(pathFor(id), async () => {
        const record = await load(id);
        if (record.status === "running") {
          await writeJsonAtomic(pathFor(id), {
            ...record,
            status: "cancelled",
            error: "Stopped by parent",
          });
          const count =
            "tasks" in record.params
              ? record.params.tasks.length
              : "chain" in record.params
                ? record.params.chain.length
                : 1;
          const ledger = new ExecutionBudgetLedger(
            options.cwd,
            record.budget_owner,
            true,
            options.budgetNodeId,
          );
          for (let index = 0; index < count; index++)
            await ledger.cancel(
              `subagent:${options.cwd}:${parent.sessionId}:${record.operationId}:${record.invocationId}:${index}`,
            );
        }
      });
    } finally {
      const keys = active.get(id);
      if (keys) await Promise.allSettled([...keys].map((key) => manager.stop(key)));
    }
  };
  const cancelAll = async () => {
    const ids = new Set(active.keys());
    try {
      for (const record of await list()) if (record.status === "running") ids.add(record.task_id);
    } finally {
      await Promise.allSettled([...ids].map(cancel));
    }
  };
  parent.once("exit", () => {
    track(cancelAll());
  });
  const run = async (record: TaskRecord): Promise<Record<string, unknown>> => {
    const id = record.task_id;
    const event = { operationId: record.operationId, invocationId: record.invocationId };
    if ((options.depth ?? 0) >= 2) throw new Error("Subagent depth limit reached");
    const params = paramsSchema.parse(record.params);
    if (typeof event.operationId !== "string" || typeof event.invocationId !== "string")
      throw new Error("Missing subagent invocation identity");
    const tasks = "chain" in params ? params.chain : "tasks" in params ? params.tasks : [params];
    const mode = "chain" in params ? "chain" : "tasks" in params ? "parallel" : "single";
    const keys = new Set<string>();
    active.set(id, keys);
    const ledger = new ExecutionBudgetLedger(
      options.cwd,
      record.budget_owner,
      true,
      options.budgetNodeId,
    );
    const execute = async (item: z.infer<typeof task>, index: number, previous = "") => {
      if (record.deadline <= Date.now()) throw new Error("Execution time budget exhausted");
      if (
        !options.executionGrantId &&
        options.sandboxCandidateId &&
        item.candidate_id &&
        options.sandboxCandidateId !== item.candidate_id
      )
        throw new Error("Child cannot widen its inherited candidate sandbox");
      const key = `subagent:${options.cwd}:${parent.sessionId}:${event.operationId}:${event.invocationId}:${index}`;
      const resultPath = workspaceFile(
        options.cwd,
        `agent-task-results/${createHash("sha256").update(key).digest("hex")}.json`,
      );
      return withFileWriteLock(resultPath, async () => {
        if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
        const saved = await readJson<Record<string, unknown> | null>(resultPath, null);
        if (saved) return saved;
        if (!record.executionScopes?.[index])
          throw new ScopeMigrationRequiredError(
            `Task ${record.task_id} has no persisted execution scope for ${item.agent} and cannot resume. Inspect committed results and possible side effects, then re-run through a new subagent invocation after explicitly declaring the role's execution_scope. Do not retry collect or infer scope from the current role definition.`,
          );
        if (!item.tools)
          throw new Error(
            `Task ${record.task_id} has no persisted tool permissions and cannot resume. Inspect prior results and dispatch a new invocation; current role/Parent tools cannot reconstruct historical authority.`,
          );
        const allowedTools = item.tools;
        const deadline = Math.min(record.deadline, (await ledger.status()).deadline);
        if (deadline <= Date.now()) throw new Error("Execution time budget exhausted");
        const resources = await parent.sendCommand("get_skills");
        const namespace = item.agent.includes("/") ? item.agent.split("/")[0] : undefined;
        if (
          namespace &&
          (!resources.success ||
            !resources.data?.skills?.some(
              (skill: { name: string; enabled: boolean }) =>
                skill.name === namespace && skill.enabled,
            ))
        )
          throw new Error(`Unknown or disabled agent: ${item.agent}`);
        const policy = resources.success
          ? (resources.data?.policy ?? options.skillPolicy)
          : options.skillPolicy;
        const definition = await resolveAgentDefinition(options.cwd, item.agent, policy);
        const prompt = definition.prompt;
        const state = await parent.sendCommand("get_state");
        if (!state.success || !state.data)
          throw new Error("Cannot establish parent tool permissions");
        if (!state.data.activeTools.includes("subagent"))
          throw new Error("Delegation permission revoked; interrupted tasks cannot resume");
        const scope = childExecutionScope(
          definition,
          record.executionScopes?.[index] ?? options.executionScope,
          options.sandboxCandidateId ?? item.candidate_id,
        );
        const ceiling = childToolAllowance(definition.tools, state.data.activeTools, scope);
        if (allowedTools.some((tool) => !ceiling.includes(tool)))
          throw new Error("Delegated tool permissions were revoked or exceed the role ceiling");
        if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
        const childBudget = await ledger.createChild(key, {
          ...item.budget,
          max_seconds: Math.min(
            600,
            item.budget?.max_seconds ?? 600,
            Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
          ),
        });
        const childDeadline = Math.min(deadline, (await childBudget.status()).deadline);
        let executionGrantId: string | undefined;
        if (
          scope !== "workspace" &&
          (item.sandbox ||
            options.executionGrantId ||
            item.candidate_id ||
            options.sandboxCandidateId)
        ) {
          const parentPolicy = options.executionGrantId
            ? await executionGrantPolicy({
                cwd: options.cwd,
                sessionId: parent.sessionId,
                budgetOperationId: options.budgetOperationId,
                budgetNodeId: options.budgetNodeId,
                executionGrantId: options.executionGrantId,
              })
            : await workspacePolicy(options.cwd, undefined, "analysis", parent.sessionId);
          let selection = item.sandbox;
          if (!selection && options.executionGrantId)
            selection = {
              cwd: parentPolicy.cwd,
              read_paths: parentPolicy.readPaths.filter(
                (path) => !parentPolicy.writePaths.includes(path),
              ),
              write_paths: parentPolicy.writePaths,
            };
          if (!selection) {
            // Explicit compatibility boundary. New tasks supply business-independent sandbox selections.
            const legacy = await legacyResearchBinding(
              {
                cwd: options.cwd,
                sessionId: parent.sessionId,
                budgetOperationId: record.budget_owner,
              },
              event.operationId,
              options.sandboxCandidateId ?? item.candidate_id!,
            );
            selection = {
              cwd: legacy.work,
              read_paths: [legacy.input],
              write_paths: [legacy.work],
            };
          }
          executionGrantId = await createExecutionGrant({
            workspace: options.cwd,
            workerKey: key,
            budgetOwner: record.budget_owner,
            deadline: childDeadline,
            tools: allowedTools,
            selection,
            parentPolicy,
            ...(options.executionGrantId ? { parentId: options.executionGrantId } : {}),
          });
        }
        keys.add(key);
        try {
          const child = await openHiddenTask(
            manager,
            key,
            {
              ...options,
              initialApproval: undefined,
              sessionId: undefined,
              prompt: { mode: "interactive", role: prompt },
              depth: (options.depth ?? 0) + 1,
              allowedTools,
              executionScope: scope,
              executionGrantId,
              delegatedAgent: item.agent,
              sandboxCandidateId: options.sandboxCandidateId ?? item.candidate_id,
              budgetOperationId: record.budget_owner,
              budgetNodeId: key,
              skillPolicy: policy ?? { mode: "inherit" },
            },
            parent.sessionId,
          );
          if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
          const authorize = (request: RuntimeEvent) => {
            if (request.type !== "capability.requested") return;
            const check = async () => {
              if (cancelled.has(id) || parent.isClosed) throw new Error("Subagent cancelled");
              const resources = await parent.sendCommand("get_skills");
              const state = await parent.sendCommand("get_state");
              if (!resources.success || !state.success || !state.data)
                throw new Error("Parent permissions unavailable");
              if (
                namespace &&
                !resources.data?.skills.some((skill) => skill.name === namespace && skill.enabled)
              )
                throw new Error(`Unknown or disabled agent: ${item.agent}`);
              const current = await resolveAgentDefinition(
                options.cwd,
                item.agent,
                resources.data?.policy,
              );
              const tool = String(request.tool);
              if (
                childExecutionScope(
                  current,
                  scope,
                  options.sandboxCandidateId ?? item.candidate_id,
                ) !== scope ||
                !allowedTools.includes(tool) ||
                !childToolAllowance(current.tools, state.data.activeTools, scope).includes(tool)
              )
                throw new Error(`Delegated tool revoked: ${tool}`);
              return { success: true };
            };
            track(
              check()
                .then(
                  (result) =>
                    child.sendNotification("subagent_response", { id: String(request.id), result }),
                  (error) =>
                    child.sendNotification("subagent_response", {
                      id: String(request.id),
                      result: { success: false, error: String(error) },
                    }),
                )
                .catch(() => undefined),
            );
          };
          child.on("event", authorize);
          let output: string;
          try {
            output = await runHiddenPrompt(
              child,
              item.task.replaceAll("{previous}", previous),
              `${event.invocationId}:${index}`,
              childDeadline,
            );
          } finally {
            child.off("event", authorize);
          }
          const stats = await child.sendCommand("get_session_stats");
          const result = {
            agent: item.agent,
            task: item.task,
            childSessionId: child.sessionId,
            exitCode: 0,
            output,
            usage: stats.success ? stats.data : undefined,
          };
          await writeJsonAtomic(resultPath, result);
          return result;
        } finally {
          await manager.stop(key);
          keys.delete(key);
        }
      });
    };
    try {
      const results: Record<string, unknown>[] = [];
      if (mode === "chain") {
        for (let index = 0; index < tasks.length; index++)
          results.push(await execute(tasks[index]!, index, String(results.at(-1)?.output ?? "")));
      } else if (mode === "parallel") {
        const settled = await Promise.allSettled(tasks.map((item, index) => execute(item, index)));
        const migration = settled.find(
          (value) =>
            value.status === "rejected" && value.reason instanceof ScopeMigrationRequiredError,
        );
        if (migration?.status === "rejected") throw migration.reason;
        for (let index = 0; index < settled.length; index++) {
          const value = settled[index]!;
          results.push(
            value.status === "fulfilled"
              ? value.value
              : { agent: tasks[index]!.agent, exitCode: 1, error: String(value.reason) },
          );
        }
      } else results.push(await execute(tasks[0]!, 0));
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      for (const result of results) {
        const child = (result.usage as { usage?: typeof usage } | undefined)?.usage;
        if (!child) continue;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
          usage[key] += child[key];
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
          usage.cost[key] += child.cost[key];
      }
      return {
        content: [
          {
            type: "text",
            text: results
              .map((value) => `${value.agent}: ${value.output ?? value.error}`)
              .join("\n\n"),
          },
        ],
        usage,
        details: {
          mode,
          results: results.map((value) => ({
            ...value,
            ...(typeof value.task === "string" ? { task: value.task.slice(0, 4000) } : {}),
            ...(typeof value.output === "string"
              ? { output: value.output.slice(0, 6000), outputTruncated: value.output.length > 6000 }
              : {}),
          })),
        },
      };
    } finally {
      active.delete(id);
    }
  };
  const view = (record: TaskRecord) => ({
    task_id: record.task_id,
    status: record.status,
    execution_deadline: record.deadline,
    ...(record.error ? { error: record.error } : {}),
    ...(record.error_code ? { error_code: record.error_code } : {}),
    recoverable:
      record.status === "running" && !!record.executionScopes && !jobs.has(record.task_id),
  });
  const toolResult = (details: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  });
  const start = (record: TaskRecord): Promise<Record<string, unknown>> => {
    const prior = jobs.get(record.task_id);
    if (prior) return prior;
    const promise = (async () => {
      let result: Record<string, unknown> | undefined,
        error: string | undefined,
        errorCode: "scope_migration_required" | undefined;
      try {
        const current = await load(record.task_id);
        if (current.status !== "running") {
          if (current.result)
            return {
              ...current.result,
              details: { ...(current.result.details as object), ...view(current) },
            };
          throw new Error(current.error ?? "Subagent cancelled");
        }
        if (record.deadline <= Date.now()) throw new Error("Execution time budget exhausted");
        result = await run(current);
      } catch (failure) {
        error = String(failure);
        if (failure instanceof ScopeMigrationRequiredError) errorCode = failure.code;
      }
      const settled = await withFileWriteLock(pathFor(record.task_id), async () => {
        const current = await load(record.task_id);
        if (current.status !== "running") return current;
        const status = errorCode
          ? "failed"
          : error
            ? /task cancelled|subagent cancelled/i.test(error)
              ? "cancelled"
              : record.deadline <= Date.now() || /deadline|time budget exhausted/i.test(error)
                ? "timed_out"
                : "failed"
            : "completed";
        const saved = {
          ...current,
          status,
          ...(result ? { result } : {}),
          ...(error ? { error } : {}),
          ...(errorCode ? { error_code: errorCode } : {}),
        };
        await writeJsonAtomic(pathFor(record.task_id), saved);
        return recordSchema.parse(saved);
      });
      if (settled.error_code) return toolResult(view(settled));
      if (!settled.result) throw new Error(settled.error ?? "Subagent cancelled");
      return {
        ...settled.result,
        details: {
          ...(settled.result.details as object),
          task_id: settled.task_id,
          status: settled.status,
        },
      };
    })();
    jobs.set(record.task_id, promise);
    track(promise);
    void promise
      .finally(() => {
        jobs.delete(record.task_id);
        active.delete(record.task_id);
        cancelled.delete(record.task_id);
      })
      .catch(() => undefined);
    return promise;
  };
  const awaitTask = async (record: TaskRecord, seconds: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (record.error_code) return toolResult(view(record));
    if (record.status !== "running")
      return record.result
        ? { ...record.result, details: { ...(record.result.details as object), ...view(record) } }
        : toolResult(view(record));
    const work = start(record);
    if (seconds === 0) return toolResult(view(record));
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Subagent wait cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      return await Promise.race([
        work,
        interrupted,
        new Promise<Record<string, unknown>>((resolve, reject) => {
          timer = setTimeout(() => {
            void load(record.task_id).then(
              (value) =>
                resolve(
                  value.result
                    ? {
                        ...value.result,
                        details: { ...(value.result.details as object), ...view(value) },
                      }
                    : toolResult(view(value)),
                ),
              reject,
            );
          }, seconds * 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  };
  parent.on("event", (event: RuntimeEvent) => {
    const id = String(event.id ?? "");
    if (event.type === "subagent.wait_cancelled") {
      waits.get(id)?.abort();
      return;
    }
    if (event.type === "subagent.cancel_all") {
      track(cancelAll());
      return;
    }
    if (event.type === "subagent.cancelled") {
      const taskId = requests.get(id);
      if (taskId) track(cancel(taskId));
      else cancelled.add(id);
      return;
    }
    if (event.type !== "subagent.requested" && event.type !== "subagent.control") return;
    const waiting = event.type === "subagent.control" ? new AbortController() : undefined;
    if (waiting) waits.set(id, waiting);
    const dispatch = async () => {
      if (event.type === "subagent.control") {
        const params = controlSchema.parse(event.params);
        if (params.action === "list") return toolResult({ tasks: (await list()).map(view) });
        if (!params.task_id) throw new Error("task_id is required");
        let record = await load(params.task_id);
        if (params.action === "stop") {
          await cancel(record.task_id);
          record = await load(record.task_id);
        }
        if (params.action === "collect")
          return awaitTask(record, params.wait_seconds ?? 30, waiting?.signal);
        return toolResult(view(record));
      }
      if (typeof event.operationId !== "string" || typeof event.invocationId !== "string")
        throw new Error("Missing subagent invocation identity");
      const taskId = digest(
        JSON.stringify([parent.sessionId, event.operationId, event.invocationId]),
      );
      requests.set(id, taskId);
      const record = await withFileWriteLock(pathFor(taskId), async () => {
        const saved = await readJson(pathFor(taskId), null);
        if (saved) return load(taskId);
        const params = paramsSchema.parse(event.params);
        const state = await parent.sendCommand("get_state");
        const resources = await parent.sendCommand("get_skills");
        if (!state.success || !state.data || !resources.success)
          throw new Error("Parent permissions unavailable");
        const items =
          "chain" in params ? params.chain : "tasks" in params ? params.tasks : [params];
        const executionScopes: ExecutionScope[] = [];
        for (const item of items) {
          const definition = await resolveAgentDefinition(
            options.cwd,
            item.agent,
            resources.data?.policy,
          );
          const declaredScope = childExecutionScope(
            definition,
            options.executionScope,
            options.sandboxCandidateId ?? item.candidate_id,
          );
          const scope = item.sandbox || options.executionGrantId ? "confined" : declaredScope;
          const ceiling = childToolAllowance(definition.tools, state.data.activeTools, scope);
          if (item.tools?.some((tool) => !ceiling.includes(tool)))
            throw new Error("Delegated tools exceed the role or parent ceiling");
          item.tools ??= ceiling;
          executionScopes.push(scope);
        }
        const owner = options.budgetOperationId ?? String(event.operationId);
        const ledger = new ExecutionBudgetLedger(
          options.cwd,
          owner,
          !!options.budgetOperationId,
          options.budgetNodeId,
        );
        const deadline = Math.min(Date.now() + 600_000, (await ledger.status()).deadline);
        const value: TaskRecord = {
          task_id: taskId,
          owner: parent.sessionId,
          operationId: String(event.operationId),
          invocationId: String(event.invocationId),
          budget_owner: owner,
          params,
          executionScopes,
          deadline,
          status: cancelled.has(id) || parent.isClosed ? "cancelled" : "running",
        };
        await writeJsonAtomic(pathFor(taskId), value);
        return value;
      });
      if (cancelled.has(id) || parent.isClosed) {
        await cancel(taskId);
        throw new Error("Subagent cancelled");
      }
      return awaitTask(record, record.params.wait_seconds ?? 600);
    };
    track(
      dispatch()
        .then(
          (data) =>
            parent.sendNotification("subagent_response", { id, result: { success: true, data } }),
          (error) =>
            parent.sendNotification("subagent_response", {
              id,
              result: {
                success: false,
                ...(error instanceof ScopeMigrationRequiredError ? { code: error.code } : {}),
                error: String(error),
              },
            }),
        )
        .catch(() => undefined)
        .finally(() => {
          requests.delete(id);
          cancelled.delete(id);
          waits.delete(id);
        }),
    );
  });
  return Object.assign(
    async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    { isBusy: () => jobs.size > 0 || active.size > 0 || pending.size > 0 },
  );
}
