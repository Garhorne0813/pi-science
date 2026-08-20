import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPythonExecutable, WorkspaceEnvironmentService, workspaceEnvironmentVariables } from "./workspace-environment.js";

describe("workspace environment platform defaults", () => {
  it("uses the Windows Python launcher name when no override is configured", () => {
    expect(defaultPythonExecutable({}, "win32")).toBe("python");
    expect(defaultPythonExecutable({}, "linux")).toBe("python3");
    expect(defaultPythonExecutable({ PYTHON: "custom-python" }, "win32")).toBe("custom-python");
  });

  it("preserves a Windows Path-only value under one canonical PATH key", () => {
    const workspace = "C:\\work\\project";
    const status = {
      ready: true, workspace, prefix: join(workspace, ".venv"), python: "python.exe", pip: "pip.exe",
      npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "npm-global"), cache: join(workspace, ".pi-science", "cache", "npm") },
    };

    const environment = workspaceEnvironmentVariables(status, { Path: "C:\\Windows\\System32", TEMP: "C:\\Temp" }, "win32");

    expect(environment.PATH?.split(";").at(-1)).toBe("C:\\Windows\\System32");
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(environment.TEMP).toBe("C:\\Temp");
    expect(environment.VIRTUAL_ENV).toBeUndefined();
    expect(environment.UV_PROJECT_ENVIRONMENT).toBeUndefined();
    expect(environment.PIP_REQUIRE_VIRTUALENV).toBeUndefined();
  });

  it("redirects global npm/pnpm tooling into the workspace node-tools dir by default", () => {
    const workspace = "/work/project";
    const status = {
      ready: true, workspace, prefix: join(workspace, ".venv"), python: join(workspace, ".venv", "bin", "python"), pip: join(workspace, ".venv", "bin", "pip"),
      npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "node-tools", "npm"), cache: join(workspace, ".pi-science", "cache", "npm") },
    };

    const environment = workspaceEnvironmentVariables(status, { PATH: "/usr/bin" }, "linux");
    expect(environment.npm_config_prefix).toBe(join(workspace, ".pi-science", "node-tools", "npm"));
    expect(environment.NPM_CONFIG_PREFIX).toBe(join(workspace, ".pi-science", "node-tools", "npm"));
    expect(environment.npm_config_cache).toBe(join(workspace, ".pi-science", "cache", "npm"));
    expect(environment.PNPM_HOME).toBe(join(workspace, ".pi-science", "node-tools", "pnpm"));
    expect(environment.COREPACK_HOME).toBe(join(workspace, ".pi-science", "cache", "corepack"));
    expect(environment.NODE_PATH).toBeUndefined();
    expect(environment.PATH).toContain(join(workspace, ".pi-science", "node-tools", "npm", "bin"));
    expect(environment.PATH).toContain(join(workspace, ".pi-science", "node-tools", "pnpm"));
  });
});

describe("workspace environment package mutation", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("creates a new immutable revision with merged packages and binds it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-env-mutation-"));
    tempDirs.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    const prefix = join(root, "micromamba", "envs", "rev_old");
    const bin = join(prefix, process.platform === "win32" ? "Scripts" : "bin");
    const python = join(bin, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(bin, { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(python, 0o755);
    await mkdir(join(root, "environments"), { recursive: true });
    await writeFile(join(root, "environments", "registry.json"), JSON.stringify({
      schema_version: 1,
      revisions: [{
        environment_id: "env_test", revision_id: "rev_old", name: "test-env", display_name: "Test Env",
        language: "python", status: "ready", prefix, packages: ["python=3.12", "pip"], platform: `${process.platform}-${process.arch}`,
        created_at: new Date().toISOString(),
      }],
    }), "utf8");
    await writeFile(join(workspace, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1,
      environment_id: "env_test", revision_id: "rev_old", bound_at: new Date().toISOString(),
    }), "utf8");

    const service = new WorkspaceEnvironmentService();
    const create = vi.spyOn(service, "create").mockImplementation(async () => ({
      environment_id: "env_test", revision_id: "rev_new", name: "test-env", display_name: "Test Env",
      language: "python", status: "ready", prefix: join(root, "micromamba", "envs", "rev_new"), packages: ["python=3.12", "pip", "numpy"],
      platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString(), supersedes_revision_id: "rev_old",
    }));
    const bind = vi.spyOn(service, "bind").mockImplementation(async (_cwd: string, revisionId: string) => ({
      ready: true, workspace,
      prefix: join(root, "micromamba", "envs", "rev_new"),
      python: join(root, "micromamba", "envs", "rev_new", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"),
      pip: join(root, "micromamba", "envs", "rev_new", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "pip.exe" : "pip"),
      environment_id: "env_test", revision_id: revisionId, manager: "micromamba",
      npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "npm-global"), cache: join(workspace, ".pi-science", "cache", "npm") },
    }));

    await expect(service.installPackages(workspace, ["numpy"])).resolves.toMatchObject({
      ready: true,
      revision_id: "rev_new",
      prefix: join(root, "micromamba", "envs", "rev_new"),
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      packages: ["python=3.12", "pip", "numpy"],
      supersedes_revision_id: "rev_old",
    }));
    expect(bind).toHaveBeenCalledWith(workspace, "rev_new");
  });

  it("reports node workspace tooling status", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-node-status-"));
    tempDirs.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "temp-project" }), "utf8");

    const service = new WorkspaceEnvironmentService();
    const status = await service.nodeStatus(root);
    expect(status.lockfile.exists).toBe(false);
    expect(status.node_modules_exists).toBe(false);
    expect(status.install_needed).toBe(true);
    expect(status.tooling.npm_prefix).toBe(join(root, ".pi-science", "node-tools", "npm"));
    expect(status.tooling.pnpm_home).toBe(join(root, ".pi-science", "node-tools", "pnpm"));
  });
});
