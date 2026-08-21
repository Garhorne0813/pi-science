import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PACKAGES, DEFAULT_R_PACKAGES, defaultPythonExecutable, WorkspaceEnvironmentService, workspaceEnvironmentVariables, type EnvironmentRevision } from "./workspace-environment.js";

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
      manager: "micromamba" as const,
      npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "npm-global"), cache: join(workspace, ".pi-science", "cache", "npm") },
    };

    const environment = workspaceEnvironmentVariables(status, {
      Path: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
      VIRTUAL_ENV: "C:\\old-venv",
      UV_PROJECT_ENVIRONMENT: "C:\\old-venv",
      PIP_REQUIRE_VIRTUALENV: "1",
      CONDA_PREFIX: "C:\\miniforge3",
      CONDA_PREFIX_1: "C:\\miniforge3\\envs\\base",
      CONDA_DEFAULT_ENV: "base",
      CONDA_EXE: "C:\\miniforge3\\Scripts\\conda.exe",
      PI_SCIENCE_PYTHON_EXECUTABLE: "C:\\old-python.exe",
    }, "win32");

    expect(environment.PATH?.split(";").at(-1)).toBe("C:\\Windows\\System32");
    expect(Object.keys(environment).filter((key) => key.toLowerCase() === "path")).toEqual(["PATH"]);
    expect(environment.TEMP).toBe("C:\\Temp");
    expect(environment.VIRTUAL_ENV).toBeUndefined();
    expect(environment.UV_PROJECT_ENVIRONMENT).toBeUndefined();
    expect(environment.PIP_REQUIRE_VIRTUALENV).toBeUndefined();
    expect(environment.CONDA_PREFIX).toBe(join(workspace, ".venv"));
    expect(environment.CONDA_PREFIX_1).toBeUndefined();
    expect(environment.CONDA_DEFAULT_ENV).toBeUndefined();
    expect(environment.CONDA_EXE).toBeUndefined();
    expect(environment.PI_SCIENCE_PYTHON_EXECUTABLE).toBeUndefined();
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

  it("rejects option-like package specs after trimming during create", async () => {
    const service = new WorkspaceEnvironmentService();
    await expect(service.create({ name: "unsafe", packages: [" --file=/host/packages.txt"] })).rejects.toThrow("Package specs must not start with '-'");
  });

  it("rejects option-like package specs after trimming during install", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-env-package-validation-"));
    tempDirs.push(root);
    const service = new WorkspaceEnvironmentService();
    await expect(service.installPackages(root, [" --file=/host/packages.txt"])).rejects.toThrow("Package specs must not start with '-'");
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
    const newPrefix = join(root, "micromamba", "envs", "rev_new");
    const newBin = join(newPrefix, process.platform === "win32" ? "Scripts" : "bin");
    const newPython = join(newBin, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(bin, { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(python, 0o755);
    await mkdir(newBin, { recursive: true });
    await writeFile(newPython, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(newPython, 0o755);
    await mkdir(join(root, "environments"), { recursive: true });
    const registryPath = join(root, "environments", "registry.json");
    await writeFile(registryPath, JSON.stringify({
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
    const create = vi.spyOn(service, "create").mockImplementation(async () => {
      const revision = {
        environment_id: "env_test", revision_id: "rev_new", name: "test-env", display_name: "Test Env",
        language: "python" as const, status: "ready" as const, prefix: newPrefix, packages: ["python=3.12", "pip", "numpy"],
        platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString(), supersedes_revision_id: "rev_old",
      };
      await writeFile(registryPath, JSON.stringify({ schema_version: 1, revisions: [revision] }), "utf8");
      return revision;
    });

    await expect(service.installPackages(workspace, ["numpy"])).resolves.toMatchObject({
      ready: true,
      revision_id: "rev_new",
      prefix: newPrefix,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      packages: ["python=3.12", "pip", "numpy"],
      supersedes_revision_id: "rev_old",
    }));
    await expect(service.binding(workspace)).resolves.toMatchObject({ revision_id: "rev_new" });
  });

  it("binds a package mutation without re-entering the workspace write lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-env-mutation-lock-"));
    tempDirs.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const workspace = join(root, "workspace");
    const oldPrefix = join(root, "micromamba", "envs", "rev_old");
    const newPrefix = join(root, "micromamba", "envs", "rev_new");
    const bin = join(newPrefix, process.platform === "win32" ? "Scripts" : "bin");
    const python = join(bin, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(python, 0o755);
    await mkdir(join(root, "environments"), { recursive: true });
    const oldRevision: EnvironmentRevision = {
      environment_id: "env_test", revision_id: "rev_old", name: "test-env", display_name: "Test Env",
      language: "python", status: "ready", prefix: oldPrefix, packages: ["python=3.12", "pip"],
      platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString(),
    };
    const newRevision = {
      ...oldRevision, revision_id: "rev_new", prefix: newPrefix, packages: ["python=3.12", "pip", "numpy"],
      supersedes_revision_id: "rev_old", created_at: new Date().toISOString(),
    };
    const registryPath = join(root, "environments", "registry.json");
    await writeFile(registryPath, JSON.stringify({ schema_version: 1, revisions: [oldRevision] }), "utf8");
    await writeFile(join(workspace, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1, environment_id: "env_test", revision_id: "rev_old", bound_at: new Date().toISOString(),
    }), "utf8");

    const service = new WorkspaceEnvironmentService();
    const create = vi.spyOn(service, "create").mockImplementation(async () => {
      await writeFile(registryPath, JSON.stringify({ schema_version: 1, revisions: [oldRevision, newRevision] }), "utf8");
      return newRevision;
    });

    await expect(service.installPackages(workspace, ["numpy"])).resolves.toMatchObject({
      ready: true, revision_id: "rev_new", prefix: newPrefix,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      packages: ["python=3.12", "pip", "numpy"], supersedes_revision_id: "rev_old",
    }));
    await expect(service.binding(workspace)).resolves.toMatchObject({ revision_id: "rev_new" });
  });

  it("checks Rscript rather than Python for an R revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-r-environment-"));
    tempDirs.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const workspace = join(root, "workspace");
    const prefix = join(root, "micromamba", "envs", "rev_r");
    const bin = join(prefix, process.platform === "win32" ? "Scripts" : "bin");
    const rscript = join(bin, process.platform === "win32" ? "Rscript.exe" : "Rscript");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(rscript, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(rscript, 0o755);
    await mkdir(join(root, "environments"), { recursive: true });
    await writeFile(join(root, "environments", "registry.json"), JSON.stringify({
      schema_version: 1,
      revisions: [{
        environment_id: "env_r", revision_id: "rev_r", name: "r-env", display_name: "R Env",
        language: "r", status: "ready", prefix, packages: ["r-base=4.4"],
        platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString(),
      }],
    }), "utf8");
    await writeFile(join(workspace, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1, environment_id: "env_r", revision_id: "rev_r", bound_at: new Date().toISOString(),
    }), "utf8");

    const status = await new WorkspaceEnvironmentService().status(workspace);
    expect(status.ready).toBe(true);
    expect(status.r).toBe(rscript);
    expect(status.error).toBeUndefined();
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

  it("exposes compute environment presets", () => {
    const service = new WorkspaceEnvironmentService();
    const presets = service.listPresets();
    expect(presets.map((preset) => preset.id)).toEqual([
      "python-minimal", "python-data", "python-science", "r-minimal",
    ]);
    expect(presets.find((preset) => preset.id === "python-science")?.packages).toContain("scipy");
    expect(presets.find((preset) => preset.id === "r-minimal")?.language).toBe("r");
  });

  it("restores scientific defaults: python provisioning equals the science preset and includes numpy", () => {
    const presets = new WorkspaceEnvironmentService().listPresets();
    const science = presets.find((preset) => preset.id === "python-science");
    expect(DEFAULT_PACKAGES).toEqual(science?.packages);
    expect(DEFAULT_PACKAGES).toEqual(expect.arrayContaining(["ipykernel", "numpy", "pandas", "scipy", "matplotlib", "seaborn"]));
  });

  it("keeps r defaults able to host notebook kernels", () => {
    expect(DEFAULT_R_PACKAGES).toEqual(expect.arrayContaining(["r-base=4.4", "r-irkernel"]));
  });

  it("rolls the workspace back to the previous ready revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-science-rollback-"));
    tempDirs.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await mkdir(join(root, "environments"), { recursive: true });
    const revOldPrefix = join(root, "micromamba", "envs", "rev_old");
    const revNewPrefix = join(root, "micromamba", "envs", "rev_new");
    await writeFile(join(root, "environments", "registry.json"), JSON.stringify({
      schema_version: 1,
      revisions: [
        { environment_id: "env_test", revision_id: "rev_old", name: "test-env", display_name: "Test Env", language: "python", status: "ready", prefix: revOldPrefix, packages: ["python=3.12", "pip"], platform: `${process.platform}-${process.arch}`, created_at: "2026-01-01T00:00:00.000Z" },
        { environment_id: "env_test", revision_id: "rev_new", name: "test-env", display_name: "Test Env", language: "python", status: "ready", prefix: revNewPrefix, packages: ["python=3.12", "pip", "numpy"], platform: `${process.platform}-${process.arch}`, created_at: "2026-01-02T00:00:00.000Z", supersedes_revision_id: "rev_old" },
      ],
    }), "utf8");
    await writeFile(join(workspace, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1, environment_id: "env_test", revision_id: "rev_new", bound_at: "2026-01-02T00:00:00.000Z",
    }), "utf8");

    const service = new WorkspaceEnvironmentService();
    const bind = vi.spyOn(service, "bind").mockImplementation(async (_cwd: string, revisionId: string) => ({
      ready: true, workspace,
      prefix: join(root, "micromamba", "envs", revisionId),
      python: join(root, "micromamba", "envs", revisionId, "bin", "python"),
      pip: join(root, "micromamba", "envs", revisionId, "bin", "pip"),
      environment_id: "env_test", revision_id: revisionId, manager: "micromamba",
      npm: { local_prefix: workspace, global_prefix: join(workspace, ".pi-science", "node-tools", "npm"), cache: join(workspace, ".pi-science", "cache", "npm") },
    }));

    await expect(service.rollback(workspace)).resolves.toMatchObject({ revision_id: "rev_old" });
    expect(bind).toHaveBeenCalledWith(workspace, "rev_old");
  });
});

describe("environment revision integrity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function seedWorkspace(): Promise<{ root: string; workspace: string; prefix: string }> {
    const root = await mkdtemp(join(tmpdir(), "pi-science-env-integrity-"));
    tempDirs.push(root);
    process.env.PI_SCIENCE_HOME = root;
    const workspace = join(root, "workspace");
    const prefix = join(root, "micromamba", "envs", "rev_old");
    const bin = join(prefix, process.platform === "win32" ? "Scripts" : "bin");
    const python = join(bin, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(join(workspace, ".pi-science"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(python, 0o755);
    await mkdir(join(prefix, "conda-meta"), { recursive: true });
    await writeFile(join(prefix, "conda-meta", "python-3.12.8-h000.json"), "{}", "utf8");
    await mkdir(join(root, "environments"), { recursive: true });
    await writeFile(join(root, "environments", "registry.json"), JSON.stringify({
      schema_version: 1,
      revisions: [{
        environment_id: "env_test", revision_id: "rev_old", name: "test-env", display_name: "Test Env",
        language: "python", status: "ready", prefix, packages: ["python=3.12", "pip"],
        platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString(),
      }],
    }), "utf8");
    await writeFile(join(workspace, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1, environment_id: "env_test", revision_id: "rev_old", bound_at: new Date().toISOString(),
    }), "utf8");
    return { root, workspace, prefix };
  }

  it("backfills a snapshot for legacy records and passes", async () => {
    const { workspace } = await seedWorkspace();
    const service = new WorkspaceEnvironmentService();

    await expect(service.bind(workspace, "rev_old")).resolves.toMatchObject({ ready: true, revision_id: "rev_old" });
    const registryPath = join(process.env.PI_SCIENCE_HOME!, "environments", "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { revisions: Array<{ integrity_snapshot?: string[] }> };
    expect(registry.revisions[0]?.integrity_snapshot).toEqual(["python-3.12.8-h000.json"]);
  });

  it("rejects binding and reports drift when the bound prefix changes out of band", async () => {
    const { workspace, prefix } = await seedWorkspace();
    const service = new WorkspaceEnvironmentService();
    await service.bind(workspace, "rev_old");

    await writeFile(join(prefix, "conda-meta", "sneaky-package-1.0-h000.json"), "{}", "utf8");

    await expect(service.bind(workspace, "rev_old")).rejects.toThrow(/modified outside Pi-Science/);
    const status = await service.status(workspace);
    expect(status.ready).toBe(false);
    expect(status.error).toMatch(/modified outside Pi-Science/);
  });
});
