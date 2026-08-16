import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceEnvironmentService } from "./workspace-environment.js";

const previousHome = process.env.PI_SCIENCE_HOME;

afterEach(() => {
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
});

describe("shared environment bindings", () => {
  it("binds two projects to one ready Micromamba revision without copying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-shared-env-"));
    process.env.PI_SCIENCE_HOME = root;
    const prefix = join(root, "micromamba", "envs", "rev_shared");
    const python = join(prefix, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    await mkdir(join(prefix, process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(python, 0o755);
    await mkdir(join(root, "environments"), { recursive: true });
    await writeFile(join(root, "environments", "registry.json"), JSON.stringify({
      schema_version: 1,
      revisions: [{
        environment_id: "env_shared", revision_id: "rev_shared", name: "shared", display_name: "Shared",
        language: "python", status: "ready", prefix, packages: ["python=3.12"], platform: `${process.platform}-${process.arch}`,
        created_at: new Date().toISOString(),
      }],
    }), "utf8");
    const first = join(root, "projects", "first");
    const second = join(root, "projects", "second");
    await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true });
    const service = new WorkspaceEnvironmentService();

    try {
      const firstStatus = await service.bind(first, "rev_shared");
      const secondStatus = await service.bind(second, "rev_shared");
      expect(firstStatus.virtual_env).toBe(prefix);
      expect(secondStatus.virtual_env).toBe(prefix);
      expect(firstStatus.revision_id).toBe("rev_shared");
      expect(JSON.parse(await readFile(join(first, ".pi-science", "environment.json"), "utf8"))).toMatchObject({ environment_id: "env_shared", revision_id: "rev_shared" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
