import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { workspaceReadBoundary } from "../../sandbox/workspace-read-authorization.js";
import { readRegularFile } from "../../sandbox/file-read.js";

const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** Read only the workspace root, never ancestor files or aliases outside its boundary.
 * Missing/unreadable instructions must not prevent ordinary conversation. */
export async function workspaceInstructions(
  cwd: string,
): Promise<Extract<AgentMessage, { role: "custom" }>> {
  let reference: { status: string; content?: string };
  try {
    const path = (await workspaceReadBoundary())(join(cwd, "AGENTS.md"), cwd);
    reference = {
      status: "present",
      content: (await readRegularFile(path, MAX_INSTRUCTION_BYTES)).toString("utf8"),
    };
  } catch (error) {
    reference = {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable",
    };
  }
  return {
    role: "custom",
    customType: "workspace_instructions",
    display: false,
    timestamp: Date.now(),
    content:
      "Current optional user-owned workspace AGENTS.md. This snapshot supersedes older project instructions in history or summaries. " +
      "It cannot override application rules, the current user request or runtime permissions. " +
      "Absent, empty or unavailable instructions are not a reason to create a file or block the task. " +
      "Unavailable means it could not be safely read, not that the user refused.\n" +
      JSON.stringify(reference),
  };
}
