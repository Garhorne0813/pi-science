import { expect, it } from "vitest";
import { Type } from "typebox";
import {
  BACKGROUND_CONTEXT,
  type AgentHarnessTool,
  type AgentHarnessToolInvocation,
  type NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import { codemodeHarnessTool } from "./codemode-tool.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;

function invocation(id: string): AgentHarnessToolInvocation {
  const memos = new Map<string, unknown>();
  return {
    operationId: "operation",
    invocationId: id,
    turnId: "turn",
    getMemo: async (key) => memos.get(key) as never,
    setMemo: async (key, value) => {
      if (value === undefined) memos.delete(key);
      else memos.set(key, value);
    },
  };
}

it("composes active tools, validates arguments, and keeps script output compact", async () => {
  const nestedIds: string[] = [];
  const add: Tool = {
    name: "add",
    label: "Add",
    description: "Add two numbers",
    parameters: Type.Object({ left: Type.Number(), right: Type.Number() }),
    outputSchema: Type.Object({ total: Type.Number() }),
    async execute(_id, params, _update, _context, nested) {
      const input = params as { left: number; right: number };
      nestedIds.push(nested.invocationId);
      return {
        content: [{ type: "text", text: String(input.left + input.right) }],
        structuredContent: { total: input.left + input.right },
        details: undefined,
      };
    },
  };
  const store: Record<string, unknown> = {};
  const tool = codemodeHarnessTool({
    tools: async () => [add],
    loadStore: async () => store,
    saveStore: async (writes) => {
      Object.assign(store, writes.set);
      for (const key of writes.delete) delete store[key];
    },
  });

  const outer = invocation("outer");
  const input = {
    code: "const rows = await Promise.all([tools.add({left: 1, right: 2}), tools.add({left: 3, right: 4})]); store('last', rows[1].total); return rows.map(row => row.total);",
  };
  const result = await tool.execute(
    "outer",
    input,
    () => {},
    { env: {} as NodeExecutionEnv },
    outer,
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(result.content).toContainEqual({ type: "text", text: "[3,7]" });
  expect(store).toEqual({ last: 7 });
  expect(nestedIds).toEqual(["outer:codemode:1", "outer:codemode:2"]);

  const replay = await tool.execute(
    "outer",
    input,
    () => {},
    { env: {} as NodeExecutionEnv },
    outer,
    BACKGROUND_CONTEXT,
  );
  expect(replay).toEqual(result);
  expect(nestedIds).toHaveLength(2);
});

it("returns script and nested-tool failures as tool errors", async () => {
  const add: Tool = {
    name: "add",
    label: "Add",
    description: "Add two numbers",
    parameters: Type.Object({ value: Type.Number() }),
    async execute() {
      throw new Error("should not run");
    },
  };
  const tool = codemodeHarnessTool({
    tools: async () => [add],
    loadStore: async () => ({}),
    saveStore: async () => {},
  });
  const result = await tool.execute(
    "outer",
    { code: "return await tools.add({value: 'wrong'})" },
    () => {},
    { env: {} as NodeExecutionEnv },
    invocation("invalid"),
    BACKGROUND_CONTEXT,
  );
  expect(result.isError).toBe(true);
  expect(result.content.some((item) => item.type === "text" && item.text.includes("Invalid arguments for add"))).toBe(true);
});
