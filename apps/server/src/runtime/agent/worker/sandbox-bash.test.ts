import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { sandboxBashTool } from "./sandbox-bash.js";

describe("Bash task descriptions", () => {
  const schema = sandboxBashTool({ cwd: process.cwd(), sessionId: "schema-test" }).parameters;

  it("accepts a concise task title alongside the executable command", () => {
    expect(Value.Check(schema, { description: "检查 Python 环境", command: "python3 -V" })).toBe(
      true,
    );
  });

  it("rejects missing, blank and overly long task titles before execution", () => {
    for (const description of [undefined, "", " \n\t", "x".repeat(81)]) {
      expect(Value.Check(schema, { command: "python3 -V", description })).toBe(false);
    }
    expect(Value.Check(schema, { description: "检查 Python 环境" })).toBe(false);
  });
});
