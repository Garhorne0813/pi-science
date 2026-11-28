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

describe("activityKind execution semantics", () => {
  it("separates shell commands and verification from kernels", () => {
    expect(activityKind(tool("bash"))).toBe("shell");
    expect(activityKind(tool("pytest"))).toBe("test");
    expect(activityKind({
      ...tool("bash"),
      presentation: { version: 1, kind: "verify", title: "Run tests", importance: "stage", domain: "code" },
    })).toBe("test");
  });

  it("keeps delegated work on the subagent renderer", () => {
    expect(activityKind(tool("subagent"))).toBe("subagent");
    expect(activityKind({ ...tool("future_tool"), childSessionId: "child-1" })).toBe("subagent");
  });
});
