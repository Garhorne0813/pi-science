import { mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { sessionApprovalPath, sessionMode } from "../../sandbox/session-approval.js";
import { configRoot, withFileWriteLock, writeJsonAtomic } from "../../../storage/persistence.js";
import type { InteractionBridge } from "./interaction-bridge.js";
import { readOperatorConfig } from "../../sandbox/operator-config.js";

const savedGrant = z.object({ bash: z.boolean().optional(), notebook: z.boolean().optional() }).strict();
type ExecutionTool = "bash" | "notebook";

async function grantPaths(cwd: string, sessionId: string) {
  const directory = join(await realpath(configRoot()), "execution-permissions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const project = createHash("sha256").update(await realpath(cwd)).digest("hex");
  return {
    conversation: (await sessionApprovalPath(cwd, sessionId)).replace(/\.json$/, "-execution.json"),
    project: join(directory, `${project}.json`),
    global: join(directory, "global.json"),
  };
}

export async function executionGrantSettings(cwd?: string) {
  const directory = join(await realpath(configRoot()), "execution-permissions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const global = await readGrants(join(directory, "global.json"));
  const project = cwd
    ? await readGrants(join(directory, `${createHash("sha256").update(await realpath(cwd)).digest("hex")}.json`))
    : {};
  return { global, project };
}

export async function revokeExecutionGrant(scope: "project" | "global", tool: ExecutionTool, cwd?: string) {
  if (scope === "project" && !cwd) throw new Error("Project workspace is required");
  const directory = join(await realpath(configRoot()), "execution-permissions");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = scope === "global"
    ? join(directory, "global.json")
    : join(directory, `${createHash("sha256").update(await realpath(cwd!)).digest("hex")}.json`);
  await withFileWriteLock(path, async () => {
    const grants = await readGrants(path);
    delete grants[tool];
    await writeJsonAtomic(path, grants, { mode: 0o600 });
  });
}

async function readGrants(path: string): Promise<z.infer<typeof savedGrant>> {
  try {
    return savedGrant.parse(await readOperatorConfig(path, 4096));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function approveLocalExecution(
  bridge: InteractionBridge,
  cwd: string,
  sessionId: string,
  tool: ExecutionTool,
  preview: string,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if ((await sessionMode(cwd, sessionId)) === "full") return true;
  const paths = await grantPaths(cwd, sessionId);
  if ((await Promise.all(Object.values(paths).map(readGrants))).some((grants) => grants[tool])) return true;
  return bridge.withPermission(JSON.stringify(["local-execution", cwd, sessionId, tool]), async () => {
    if ((await Promise.all(Object.values(paths).map(readGrants))).some((grants) => grants[tool])) return true;
    const answer = await bridge.request(`Run ${tool}?`, "", signal, {
      kind: "permission",
      method: "select",
      toolCallId,
      message: preview.slice(0, 4000),
      options: [
        { value: "once", label: "Allow once" },
        { value: "conversation", label: "Allow in this conversation" },
        { value: "project", label: "Allow in this project" },
        { value: "global", label: "Always allow" },
        { value: "deny", label: "Deny" },
      ],
      presentation: {
        titleKey: "interaction.localExecution.title",
        titleParams: { tool },
        optionLabelKeys: {
          once: "interaction.allowOnce",
          conversation: "interaction.allowConversation",
          project: "interaction.allowProject",
          global: "interaction.allowGlobal",
          deny: "interaction.deny",
        },
      },
    });
    signal?.throwIfAborted();
    if (answer === "conversation" || answer === "project" || answer === "global") {
      const path = paths[answer];
      await withFileWriteLock(path, async () => {
        await writeJsonAtomic(path, { ...await readGrants(path), [tool]: true }, { mode: 0o600 });
      });
    }
    return answer === "once" || answer === "conversation" || answer === "project" || answer === "global";
  }, signal);
}
