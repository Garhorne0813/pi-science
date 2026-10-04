import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executionIdFor, executionRepository } from "../executions/execution-repository.js";
import { observeAgentEvent } from "./agent-event-observer.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-science-pi-evidence-"));
  workspaces.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

describe("agent execution evidence", () => {
  it("records a tool lifecycle, redacts secrets, and links written artifacts", async () => {
    const cwd = await workspace();
    const sessionId = "session-evidence";
    const toolCallId = "call-evidence";
    const path = "results/output.txt";
    await mkdir(join(cwd, "results"), { recursive: true });

    await observeAgentEvent(cwd, "model-test", {
      type: "tool.started", runId: "r",
      toolCallId,
      toolName: "write",
      args: { path, content: "result", api_key: "must-not-leak" },
    }, sessionId, async () => undefined);
    await writeFile(join(cwd, path), "result", "utf8");
    await observeAgentEvent(cwd, "model-test", {
      type: "tool.completed", runId: "r",
      toolCallId,
      toolName: "write",
      args: { path, content: "result" },
      result: { ok: true },
      isError: false,
    }, sessionId, async () => undefined);

    const execution = await executionRepository.get(cwd, executionIdFor("agent-tool", sessionId, toolCallId));
    expect(execution).toMatchObject({
      status: "succeeded",
      correlation: { session_id: sessionId, tool_call_id: toolCallId },
      request: { tool: "write", input: { api_key: "[redacted]" } },
    });
    expect(execution?.files.written).toEqual([expect.objectContaining({ path, artifact_id: expect.any(String), artifact_version: 1 })]);
    expect(execution?.artifacts).toEqual([expect.objectContaining({ relation: "output", version: 1 })]);
  });
});
