import { mkdtemp, mkdir, realpath, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { workspaceInstructions } from "./workspace-instructions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  // Windows TEMP can use an 8.3 alias; the production workspace is canonical too.
  const root = await realpath(await mkdtemp(join(tmpdir(), "workspace-instructions-")));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd, path: join(cwd, "AGENTS.md") };
}
function text(message: Awaited<ReturnType<typeof workspaceInstructions>>) {
  return String(message.content);
}

it("loads a regular file from a canonical native workspace", async () => {
  const { cwd, path } = await fixture();
  await writeFile(path, "USER_PROJECT_GUIDANCE");
  const message = text(await workspaceInstructions(cwd));
  expect(message).toContain('"status":"present"');
  expect(message).toContain("USER_PROJECT_GUIDANCE");
});

it("does not inherit ancestor instructions or load legacy project documents", async () => {
  const { root, cwd } = await fixture();
  await writeFile(join(root, "AGENTS.md"), "ANCESTOR_INSTRUCTIONS");
  await writeFile(join(cwd, "PROJECT.md"), "LEGACY_DOCUMENT");
  const message = text(await workspaceInstructions(cwd));
  expect(message).toContain('"status":"absent"');
  expect(message).not.toMatch(/ANCESTOR_INSTRUCTIONS|LEGACY_DOCUMENT/);
});

it.each(["symlink", "hardlink", "directory", "oversized"])(
  "does not inject unsafe %s instructions",
  async (kind) => {
    const { root, cwd, path } = await fixture();
    const outside = join(root, "outside.md");
    await writeFile(outside, "OUTSIDE_INSTRUCTIONS");
    if (kind === "symlink") await symlink(outside, path);
    if (kind === "hardlink") await link(outside, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "oversized") await writeFile(path, "LARGE_INSTRUCTIONS".repeat(8192));
    const message = text(await workspaceInstructions(cwd));
    expect(message).toContain('"status":"unavailable"');
    expect(message).not.toMatch(/OUTSIDE_INSTRUCTIONS|LARGE_INSTRUCTIONS/);
  },
);
