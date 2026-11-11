import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  BACKGROUND_CONTEXT,
  NodeExecutionEnv,
  type AgentHarnessToolInvocation,
} from "@earendil-works/pi-agent-core/node";
import { selectToolProgressDisplay, type ToolProgressV1 } from "@pi-science/contracts";
import { sandboxBashTool } from "./sandbox-bash.js";
import { ConversationProjection } from "../../events/conversation/projection.js";
import { ConversationStreams } from "../../events/conversation/streams.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const invocation: AgentHarnessToolInvocation = {
  operationId: "op",
  invocationId: "progress",
  turnId: "turn",
  getMemo: async () => undefined,
  setMemo: async () => {},
};
const progressLine = `<<pi-progress>> ${JSON.stringify({ version: 1, scopeId: "scan:1", scopeLabel: "Scanning files", current: 3, total: 5, unit: "files", totalKind: "fixed" })}`;

it.skipIf(!["linux", "darwin"].includes(process.platform))(
  "carries real Bash progress into a tool.updated event with the sentinel removed",
  async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "pi-progress-roundtrip-")));
    roots.push(cwd);
    await mkdir(join(cwd, ".pi-science"));
    const snapshots: unknown[] = [];
    const result = await sandboxBashTool({ cwd, sessionId: "progress" }).execute(
      "progress",
      {
        command: `printf 'scanning\\n'; sleep 0.3; printf '%s\\n' '${progressLine}'; sleep 0.3; printf 'scanned\\n'`,
        timeout: 10,
      },
      (snapshot) => {
        snapshots.push(snapshot);
      },
      { env: new NodeExecutionEnv({ cwd }) },
      invocation,
      BACKGROUND_CONTEXT,
    );

    const visible = JSON.stringify(result);
    expect(visible).toContain("scanning");
    expect(visible).toContain("scanned");
    expect(visible).not.toContain("<<pi-progress>>");
    expect(snapshots.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshots)).not.toContain("<<pi-progress>>");

    const projection = new ConversationProjection(new ConversationStreams({}));
    const events = snapshots.map(
      (snapshot) =>
        projection.normalize(cwd, "session", {
          type: "tool.updated",
          toolCallId: "call",
          toolName: "bash",
          partialResult: snapshot,
        } as never)[0]! as { partialOutput?: string; progress?: ToolProgressV1 },
    );
    expect(events.map((event) => event.partialOutput ?? "").join("")).not.toContain(
      "<<pi-progress>>",
    );
    expect(
      events.map((event) => selectToolProgressDisplay("running", event.progress)),
    ).toContainEqual({
      mode: "determinate",
      current: 3,
      total: 5,
      percent: 60,
      scopeLabel: "Scanning files",
      unit: "files",
    });

    // The settled result keeps the last measured value, so the row does not
    // blank out the moment the call ends, and history can restore it.
    const settled = (result as { details?: { progress?: unknown } }).details?.progress;
    expect(settled).toMatchObject({
      scopeId: "emitter:scan:1",
      current: 3,
      total: 5,
      unit: "files",
    });
    const completed = projection.normalize(cwd, "session", {
      type: "tool.completed",
      toolCallId: "call",
      toolName: "bash",
      result: "scanned",
      details: (result as { details?: unknown }).details,
      isError: false,
    } as never);
    expect(completed[0]).toMatchObject({
      type: "tool.completed",
      progress: { scopeId: "emitter:scan:1", current: 3, total: 5, determinate: true },
    });
  },
  30_000,
);
