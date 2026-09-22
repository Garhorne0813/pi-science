import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceFile } from "../../security/workspace-security.js";
import { captureArtifactBlob } from "./artifact-blob-store.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("artifact blob capture", () => {
  it.skipIf(process.platform === "win32")("does not follow a source replaced by a symlink after validation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-artifact-capture-"));
    const outside = await mkdtemp(join(tmpdir(), "pi-science-artifact-secret-"));
    paths.push(cwd, outside);
    await mkdir(join(cwd, ".pi-science"));
    const source = join(cwd, "result.txt");
    await writeFile(source, "safe");
    const validated = await resolveWorkspaceFile(cwd, "result.txt");
    await writeFile(join(outside, "secret.txt"), "host secret");
    await unlink(source);
    await symlink(join(outside, "secret.txt"), source);

    await expect(captureArtifactBlob(cwd, validated)).rejects.toThrow(/regular file|symbolic link/i);
  });
});
