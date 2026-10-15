import { AiTitleService } from "../title/ai-title-service.js";
import { openHiddenTask, runHiddenPrompt } from "../agent/hidden-agent-task.js";
import { ProjectReviewService } from "../../project-review/service.js";
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withWorkspaceAdmission, withWorkspaceMutation, WorkspaceLifecycleBusyError } from "./workspace-lifecycle.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(join(tmpdir(), "workspace-lifecycle-")); roots.push(root); return root; }
function latch() { let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); return { wait, release }; }
it("blocks mutation from admission through acknowledgement while allowing concurrent conversations", async () => {
  const cwd = await workspace(); const entered = latch(); const finish = latch();
  const admission = withWorkspaceAdmission(cwd, async () => { entered.release(); await finish.wait; });
  await entered.wait;
  try {
    await withWorkspaceAdmission(cwd, async () => undefined);
    await expect(withWorkspaceMutation([cwd], async () => undefined)).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    await expect(withWorkspaceMutation([join(cwd, "nested")], async () => undefined)).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
  } finally { finish.release(); await admission; }
  await withWorkspaceMutation([cwd], async () => undefined);
});
it("reserves source, destination and descendants across aliases, disappearance and rollback", async () => {
  const root = await workspace(); const source = join(root, "source"); const target = join(root, "target"); const alias = join(root, "alias");
  await mkdir(source); await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(withWorkspaceMutation([source, target, join(alias, "source")], async () => {
    await rename(source, target);
    for (const cwd of [source, target, join(alias, "source"), join(alias, "target/nested")]) {
      await expect(withWorkspaceAdmission(cwd, async () => undefined)).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    }
    await expect(withWorkspaceMutation([target], async () => undefined)).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    await withWorkspaceAdmission(join(root, "unrelated"), async () => undefined);
    await rename(target, source); throw new Error("rollback");
  })).rejects.toThrow("rollback");
  await withWorkspaceAdmission(source, async () => undefined);
  await withWorkspaceMutation([target], async () => undefined);
});
it("releases failed admission without leaving the workspace locked", async () => {
  const cwd = await workspace();
  await expect(withWorkspaceAdmission(cwd, async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
  await withWorkspaceMutation([cwd], async () => undefined);
});

it("rejects hidden agent ownership writes and background review before they touch a mutating workspace", async () => {
  const cwd = await workspace(); const start = vi.fn(); const sendCommand = vi.fn();
  const review = new ProjectReviewService({ review: vi.fn(), shutdown: vi.fn() } as never);
  await withWorkspaceMutation([cwd], async () => {
    await expect(openHiddenTask({ start } as never, "hidden", { cwd, sessionsRoot: join(cwd, "sessions"), model: { provider: "openai", modelId: "test" } }, "parent")).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    await expect(runHiddenPrompt({ cwd, sendCommand } as never, "new task", "id", Date.now() + 1000)).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    await expect(review.run(cwd, { trigger: "auto", sessionId: "session" })).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    await expect(new AiTitleService({ start }).generateTitle(cwd, "session")).rejects.toBeInstanceOf(WorkspaceLifecycleBusyError);
    expect(start).not.toHaveBeenCalled(); expect(sendCommand).not.toHaveBeenCalled(); expect(await readdir(cwd)).toEqual([]);
  });
});
