import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../../types/thread";
import { activityKind } from "./adapter";

function tool(name: string): ToolCallBlock {
  return { kind: "tool", id: `tool-${name}`, callId: `call-${name}`, tool: name, status: "done" };
}

describe("activityKind notebook semantics", () => {
  it("keeps file-backed notebook reads and edits out of the kernel renderer", () => {
    expect(activityKind(tool("notebook_read"))).toBe("file");
    expect(activityKind(tool("notebook_edit"))).toBe("file");
  });

  it("uses the kernel renderer for notebook and code execution tools", () => {
    expect(activityKind(tool("notebook_run"))).toBe("kernel");
    expect(activityKind(tool("run_cell"))).toBe("kernel");
    expect(activityKind(tool("execute_code"))).toBe("kernel");
    expect(activityKind(tool("python"))).toBe("kernel");
  });
});
