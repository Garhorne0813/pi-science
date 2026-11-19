import {
  CodemodeSandbox,
  parseCodemodeSource,
  type CodemodeJsonSchema,
  type CodemodeResult,
  type CodemodeStoreWrites,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  AgentHarnessTool,
  AgentHarnessToolInvocation,
  Context,
  JsonValue,
  NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";

type HarnessTool = AgentHarnessTool<{ env: NodeExecutionEnv }>;
type HarnessResult = Awaited<ReturnType<HarnessTool["execute"]>>;

export interface CodemodeToolOptions {
  tools(context: Context): Promise<HarnessTool[]>;
  loadStore(context: Context): Promise<Record<string, unknown>>;
  saveStore(writes: CodemodeStoreWrites, context: Context): Promise<void>;
}

const RESULT_MEMO = "codemode-result";
const EXECUTION_MEMO = "codemode-execution";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_TOKENS = 10_000;

function textResult(result: HarnessResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (
    result.details &&
    typeof result.details === "object" &&
    !Array.isArray(result.details) &&
    "result" in result.details &&
    result.details.result !== undefined
  )
    return result.details.result;
  const text = result.content.filter((item) => item.type === "text").map((item) => item.text);
  const images = result.content.filter((item) => item.type === "image");
  if (images.length) return result.content;
  return text.length === 1 ? text[0] : text.join("\n");
}

function failureText(result: HarnessResult): string {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "Nested tool call failed";
}

function nestedInvocation(
  parent: AgentHarnessToolInvocation,
  invocationId: string,
): AgentHarnessToolInvocation {
  const prefix = `codemode:${invocationId}:`;
  return {
    operationId: parent.operationId,
    invocationId,
    turnId: parent.turnId,
    getMemo: (name) => parent.getMemo(`${prefix}${name}`),
    setMemo: (name, value) => parent.setMemo(`${prefix}${name}`, value),
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[Codemode output truncated]\n\n";
  if (maxChars <= marker.length + 2) return text.slice(0, maxChars);
  const side = Math.floor((maxChars - marker.length) / 2);
  return `${text.slice(0, side)}${marker}${text.slice(-(maxChars - marker.length - side))}`;
}

function toHarnessResult(result: CodemodeResult, maxOutputTokens: number): HarnessResult {
  const rawContent = [...result.output];
  if (result.ok && result.value !== undefined) {
    const serialized =
      typeof result.value === "string" ? result.value : JSON.stringify(result.value);
    if (serialized !== undefined) rawContent.push({ type: "text", text: serialized });
  }
  if (!result.ok)
    rawContent.unshift({
      type: "text",
      text: result.error.stack ?? result.error.message,
    });
  let remainingChars = maxOutputTokens * 4;
  const content: HarnessResult["content"] = [];
  for (const item of rawContent) {
    if (item.type === "image") {
      content.push(item);
      continue;
    }
    if (remainingChars <= 0) continue;
    const text = truncateText(item.text, remainingChars);
    content.push({ type: "text", text });
    remainingChars -= text.length;
  }
  return {
    content,
    details: { calls: result.calls },
    isError: !result.ok,
  };
}

function isHarnessResult(value: JsonValue | undefined): value is HarnessResult & JsonValue {
  return (
    !!value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.content)
  );
}

function isCodemodeResult(value: JsonValue | undefined): value is CodemodeResult & JsonValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.output) &&
    Array.isArray(value.calls)
  );
}

/** A script sandbox that composes the lane's currently active, already-policy-wrapped tools. */
export function codemodeHarnessTool(options: CodemodeToolOptions): HarnessTool {
  return {
    name: "codemode",
    label: "Codemode",
    description:
      'Run JavaScript that composes the other active tools in one call. Use await tools.<name>(args), Promise.all for independent calls, and return or text() for the result. ALL_TOOLS lists callable tools. Direct tools remain available for simple one-step work. The sandbox has no filesystem, network, Node APIs, imports, or timers except through tools. Scripts may start with // @options: {"timeout_ms": 60000, "max_output_tokens": 2000}.',
    parameters: Type.Object(
      {
        code: Type.String({ minLength: 1, description: "JavaScript async-function body" }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, update, toolContext, invocation, context) {
      const input = params as { code: string };
      const replay = await invocation.getMemo(RESULT_MEMO);
      if (isHarnessResult(replay)) return replay;

      const parsed = parseCodemodeSource(input.code);
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1, parsed.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      );
      const maxOutputTokens = Math.min(
        DEFAULT_OUTPUT_TOKENS,
        Math.max(1, parsed.options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS),
      );
      const completedExecution = await invocation.getMemo(EXECUTION_MEMO);
      if (isCodemodeResult(completedExecution)) {
        if (completedExecution.ok) await options.saveStore(completedExecution.storeWrites, context);
        const final = toHarnessResult(completedExecution, maxOutputTokens);
        await invocation.setMemo(RESULT_MEMO, final as unknown as JsonValue);
        return final;
      }

      const active = (await options.tools(context)).filter((tool) => tool.name !== "codemode");
      let callIndex = 0;
      const sandboxTools: CodemodeTool[] = active.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as CodemodeJsonSchema,
        outputSchema: tool.outputSchema as CodemodeJsonSchema | undefined,
        execute: async (args, nested) => {
          if (!Value.Check(tool.parameters, args))
            throw new Error(`Invalid arguments for ${tool.name}`);
          const invocationId = `${invocation.invocationId}:codemode:${++callIndex}`;
          const abortSignal = context.abortSignal
            ? AbortSignal.any([context.abortSignal, nested.signal])
            : nested.signal;
          update({
            content: [],
            details: { nested: { tool: tool.name, invocationId, status: "running" } },
          });
          const result = await tool.execute(
            invocationId,
            args as never,
            (partial) =>
              update({
                content: [],
                details: { nested: { tool: tool.name, invocationId, partial } },
              }),
            toolContext,
            nestedInvocation(invocation, invocationId),
            { ...context, abortSignal },
          );
          if (result.isError) throw new Error(failureText(result));
          return textResult(result);
        },
      }));
      update({ content: [], details: { status: "running" } });
      const sandbox = new CodemodeSandbox({
        tools: sandboxTools,
        timeoutMs,
        memoryLimitBytes: 128 * 1024 * 1024,
      });
      try {
        const result = await sandbox.execute(parsed.code, {
          signal: context.abortSignal,
          timeoutMs,
          store: await options.loadStore(context),
        });
        await invocation.setMemo(EXECUTION_MEMO, result as unknown as JsonValue);
        if (result.ok) await options.saveStore(result.storeWrites, context);
        const final = toHarnessResult(result, maxOutputTokens);
        await invocation.setMemo(RESULT_MEMO, final as unknown as JsonValue);
        return final;
      } finally {
        await sandbox.close();
      }
    },
  };
}
