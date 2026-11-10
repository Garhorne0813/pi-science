import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { notebookHarnessTools } from "./notebook-tools.js";

describe("notebook task descriptions", () => {
  const tools = notebookHarnessTools(process.cwd(), "schema-test");
  const schema = tools.find((tool) => tool.name === "notebook_run")!.parameters;
  const args = { path: "analysis.ipynb", cell_ids: ["fit-model"] };

  it("requires a nonblank task title for execution", () => {
    expect(Value.Check(schema, args)).toBe(false);
    expect(Value.Check(schema, { ...args, description: " " })).toBe(false);
    expect(Value.Check(schema, { ...args, description: "拟合回归模型" })).toBe(true);
  });

  it("preserves execution constraints and read tools without adding metadata requirements", () => {
    const valid = { ...args, description: "拟合回归模型" };
    expect(Value.Check(schema, { ...valid, cell_ids: [] })).toBe(false);
    expect(Value.Check(schema, { ...valid, unexpected: true })).toBe(false);
    const read = tools.find((tool) => tool.name === "notebook_read")!;
    expect(Value.Check(read.parameters, { path: "analysis.ipynb" })).toBe(true);
  });
});
