import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { AgentCoreRuntimeClient } from "./agent-runtime-client.js";
import { AgentSessionRepository } from "./agent-session-repository.js";
import { listWorkspaceSessions, workspaceIdentity } from "./workspace-session-identity.js";

it("reopens an alias-spelled transcript in a canonical worker without including another workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-workspace-identity-"));
  const original = join(root, "workspace");
  const alias = join(root, "alias");
  const other = join(root, "other");
  let client: AgentCoreRuntimeClient | undefined;
  let env: NodeExecutionEnv | undefined;
  let repo: JsonlSessionRepo | undefined;
  try {
    await mkdir(original);
    await mkdir(other);
    await symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
    const cwd = await realpath(original);
    const sessionsRoot = join(cwd, ".pi-science", "agent-sessions");
    env = new NodeExecutionEnv({ cwd });
    repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });
    const session = await repo.create({ cwd: alias }, BACKGROUND_CONTEXT);
    const sessionId = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    const foreign = await repo.create({ cwd: other }, BACKGROUND_CONTEXT);
    await foreign.close(BACKGROUND_CONTEXT);
    expect(workspaceIdentity(alias)).toBe(workspaceIdentity(cwd));
    expect((await listWorkspaceSessions(repo, cwd)).map((item) => item.id)).toEqual([sessionId]);
    const projection = new AgentSessionRepository();
    expect(await projection.findPath(cwd, sessionId)).toBeTruthy();
    expect(await projection.findPath(alias, sessionId)).toBe(await projection.findPath(cwd, sessionId));
    expect(await projection.findPath(cwd, foreign.metadata.id)).toBeNull();
    await repo.close(BACKGROUND_CONTEXT);
    repo = undefined;
    await env.cleanup(BACKGROUND_CONTEXT);
    env = undefined;
    client = await AgentCoreRuntimeClient.start({ cwd, sessionsRoot, sessionId,
      model: { provider: "openai", modelId: "gpt-4.1-mini" }, thinking: "off", deferActivation: true }, 5000);
    expect(await client.sendCommand("get_state")).toMatchObject({ success: true, data: { sessionId, busy: false } });
  } finally {
    await client?.shutdown();
    await repo?.close(BACKGROUND_CONTEXT);
    await env?.cleanup(BACKGROUND_CONTEXT);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
