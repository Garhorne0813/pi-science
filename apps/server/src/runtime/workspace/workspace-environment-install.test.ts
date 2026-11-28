import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  environmentPythonExecutable,
  WorkspaceEnvironmentService,
} from "./workspace-environment.js";
import { runEnvironmentProcess } from "../sandbox/environment-process.js";
import { installPythonWheels } from "../sandbox/python-wheel-install.js";
vi.mock("../sandbox/environment-process.js", () => ({ runEnvironmentProcess: vi.fn() }));

it("creates a canonical package-manager root inside the granted cache before entering the installer sandbox", async () => {
  // tmpdir may use the OS alias (/var on macOS), as real application homes do.
  const home = await mkdtemp(join(tmpdir(), "pi-science-install-path-"));
  vi.stubEnv("PI_SCIENCE_HOME", home);
  const service = new WorkspaceEnvironmentService();
  (service as unknown as { ensureMicromamba: () => Promise<string> }).ensureMicromamba = async () =>
    process.execPath;
  vi.mocked(runEnvironmentProcess).mockImplementation(
    async (_command, args, prefix, cache, _timeout, env) => {
      expect(prefix).toBe(await realpath(prefix));
      expect(args[args.indexOf("--prefix") + 1]).toBe(prefix);
      expect(cache).toBe(await realpath(cache!));
      expect(env?.MAMBA_ROOT_PREFIX).toBe(join(cache!, "root"));
      expect(env?.CONDA_PKGS_DIRS).toBe(cache);
      expect((await stat(env!.MAMBA_ROOT_PREFIX!)).isDirectory()).toBe(true);
      throw new Error("Installer boundary checked");
    },
  );
  try {
    await expect(service.create({ name: "test", packages: ["python=3.12"] })).rejects.toThrow(
      "Installer boundary checked",
    );
    expect(runEnvironmentProcess).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it.each([
  { version: "24.1.2", usesSystemTrust: false },
  { version: "24.2", usesSystemTrust: true },
  { version: "26.2.1", usesSystemTrust: true },
])(
  "selects the certificate backend for sandboxed pip $version",
  async ({ version, usesSystemTrust }) => {
    const prefix = await mkdtemp(join(tmpdir(), "pi-science-pip-certificates-"));
    const run = vi.mocked(runEnvironmentProcess).mockReset().mockResolvedValue(undefined);
    try {
      await installPythonWheels(process.execPath, prefix, ["peppercorn==0.6"], [`pip==${version}`]);
      const command = run.mock.calls[0]![1];
      expect(command.includes("--use-deprecated=legacy-certs")).toBe(
        process.platform === "darwin" && usesSystemTrust,
      );
      expect(run.mock.calls[0]![6]).toMatchObject({
        requireSandbox: true,
        restrictNetworkTo: ["pypi.org:443", "files.pythonhosted.org:443"],
      });
    } finally {
      run.mockReset();
      await rm(prefix, { recursive: true, force: true });
    }
  },
);

it("binds complete pip revisions, rejects stale approvals, and restores the previous revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-science-pip-revisions-"));
  const state = join(root, "state");
  const home = join(root, "alias");
  await mkdir(state);
  await symlink(state, home, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("PI_SCIENCE_HOME", home);
  const { SqliteStateStore } = await import("../../storage/sqlite/state-store.js");
  const { EnvironmentRepository } = await import(
    "../../storage/sqlite/repositories/environment-repository.js"
  );
  const store = new SqliteStateStore({ path: join(home, "state.sqlite") });
  const repository = new EnvironmentRepository(store);
  const workspace = join(home, "workspace");
  const prefix = join(home, "micromamba", "envs", "rev_base");
  const filename = "python-3.12.8-h000.json";
  const record = {
    url: "https://conda.anaconda.org/conda-forge/noarch/python-3.12.8-h000.conda",
    md5: "a".repeat(32),
  };
  const inventories = new Map<string, string[][]>();
  let corruptInventory = false;
  const cancellation = new AbortController();
  const seed = async (target: string) => {
    await mkdir(join(target, "conda-meta"), { recursive: true });
    await writeFile(join(target, "conda-meta", filename), JSON.stringify(record));
    const python = environmentPythonExecutable(target);
    await mkdir(dirname(python), { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    inventories.set(await realpath(target), [["numpy", "2.2.0"]]);
  };
  const service = new WorkspaceEnvironmentService(process.execPath, repository);
  vi.mocked(runEnvironmentProcess).mockImplementation(
    async (_command, args, target, _cache, _timeout, _env, options) => {
      if (args[0] === "create") {
        expect(args).toContain("--always-copy");
        const manifest = await readFile(args[args.indexOf("--file") + 1]!, "utf8");
        expect(manifest).toBe(`@EXPLICIT\n${record.url}#${record.md5}\n`);
        await seed(target);
      } else if (args[0] === "run") {
        const constraintPath = args[args.indexOf("--constraint") + 1]!;
        expect(await readFile(constraintPath, "utf8")).toContain("numpy==2.2.0");
        const packages = args.slice(args.indexOf("--") + 1);
        if (packages.includes("cancelled"))
          cancellation.abort(new Error("Cancelled during install"));
        options?.signal?.throwIfAborted();
        options?.stdout?.(
          JSON.stringify({
            install: packages.map((name) => ({
              is_direct: false,
              metadata: { name, version: "1.0" },
              download_info: {
                url: `https://files.pythonhosted.org/packages/${name}.whl`,
                archive_info: { hashes: { sha256: "b".repeat(64) } },
              },
            })),
          }),
        );
        inventories.set(await realpath(target), [
          ["numpy", corruptInventory ? "3.0.0" : "2.2.0"],
          ...packages.map((name) => [name, "1.0"]),
        ]);
      } else if (options?.stdout) {
        const inventory = inventories.get(await realpath(target));
        if (!inventory) throw new Error(`No Python inventory seeded for ${target}`);
        options.stdout(JSON.stringify(inventory));
      }
    },
  );
  try {
    await store.start();
    await seed(prefix);
    await repository.upsert({
      environment_id: "env_python_standard",
      revision_id: "rev_base",
      name: "standard",
      display_name: "Standard",
      language: "python",
      status: "ready",
      prefix,
      packages: ["python", "numpy"],
      platform: `${process.platform}-${process.arch}`,
      created_at: new Date().toISOString(),
    });
    await service.bind(workspace, "rev_base");
    const install = (pkg: string, revision: string) =>
      service.installPackages(workspace, {
        manager: "pip",
        packages: [pkg],
        expectedRevisionId: revision,
      });
    const [first, stale] = await Promise.allSettled([
      install("sympy", "rev_base"),
      install("pint", "rev_base"),
    ]);
    if (first.status !== "fulfilled") throw first.reason;
    expect(stale).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("changed") }),
    });
    const second = await install("pint", first.value.revision_id!);
    expect(second.pip_packages).toEqual(["sympy", "pint"]);
    expect(await repository.get(second.revision_id!)).toMatchObject({
      pip_packages: ["sympy", "pint"],
      resolved_python_packages: ["numpy==2.2.0", "pint==1.0", "sympy==1.0"],
      pip_wheels: expect.arrayContaining([
        expect.objectContaining({ name: "sympy", sha256: "b".repeat(64) }),
      ]),
      integrity_snapshot: [expect.stringContaining("conda-meta/")],
    });
    await store.close();
    await store.start();
    const reopened = new WorkspaceEnvironmentService(process.execPath, repository);
    expect(await reopened.status(workspace)).toMatchObject({
      revision_id: second.revision_id,
      ready: true,
    });
    vi.stubEnv("NODE_ENV", "production");
    expect(await reopened.ensure(join(home, "other-workspace"))).toMatchObject({
      revision_id: "rev_base",
    });
    corruptInventory = true;
    await expect(install("tzdata", second.revision_id!)).rejects.toThrow(
      "would change existing Python dependencies",
    );
    await expect(
      service.installPackages(workspace, {
        manager: "pip",
        packages: ["cancelled"],
        expectedRevisionId: second.revision_id!,
        signal: cancellation.signal,
      }),
    ).rejects.toThrow("Cancelled during install");
    expect((await reopened.status(workspace)).revision_id).toBe(second.revision_id);
    const failed = (await repository.list()).filter((revision) => revision.status === "failed");
    expect(failed).toHaveLength(2);
    for (const revision of failed)
      await expect(stat(revision.prefix)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await reopened.rollback(workspace)).revision_id).toBe(first.value.revision_id);
    expect(await readFile(join(prefix, "conda-meta", filename), "utf8")).toBe(
      JSON.stringify(record),
    );
  } finally {
    await store.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers abandoned pip revisions after restart and preserves live and published revisions", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-science-pip-recovery-"));
  vi.stubEnv("PI_SCIENCE_HOME", home);
  const { SqliteStateStore } = await import("../../storage/sqlite/state-store.js");
  const { EnvironmentRepository } = await import(
    "../../storage/sqlite/repositories/environment-repository.js"
  );
  const store = new SqliteStateStore({ path: join(home, "state.sqlite") });
  const repository = new EnvironmentRepository(store);
  const environments = new WorkspaceEnvironmentService(process.execPath, repository);
  const workspace = join(home, "workspace");
  const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(1)"]);
  const seed = async (
    suffix: string,
    status: "ready" | "creating",
    build_owner_pid?: number,
    outside = false,
  ) => {
    const revision_id = `rev_${suffix.repeat(32)}`;
    const prefix = outside ? join(home, "outside") : join(home, "micromamba", "envs", revision_id);
    const python = environmentPythonExecutable(prefix);
    await mkdir(dirname(python), { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return repository.upsert({
      environment_id: "env_test",
      revision_id,
      prefix,
      status,
      language: "python",
      name: "test",
      display_name: "Test",
      platform: process.platform,
      created_at: new Date().toISOString(),
      packages: ["python", "pip"],
      pip_packages: ["sympy"],
      build_owner_pid,
    });
  };
  try {
    expect(deadProcess.status).toBe(1);
    expect(deadProcess.pid).toBeGreaterThan(0);
    await store.start();
    const ready = await seed("a", "ready");
    const interrupted = await seed("b", "creating", deadProcess.pid);
    const live = await seed("c", "creating", process.pid);
    const invalid = await seed("d", "creating", deadProcess.pid, true);
    await environments.bind(workspace, ready.revision_id);
    await store.close();
    await store.start();

    expect(await environments.recoverInterruptedInstalls()).toBe(1);
    expect(await environments.recoverInterruptedInstalls()).toBe(0);
    expect(await repository.get(interrupted.revision_id)).toMatchObject({
      status: "failed",
      failure: { stage: "recovery" },
    });
    await expect(stat(interrupted.prefix)).rejects.toMatchObject({ code: "ENOENT" });
    for (const revision of [live, invalid, ready]) {
      expect(await repository.get(revision.revision_id)).toMatchObject({ status: revision.status });
      expect((await stat(revision.prefix)).isDirectory()).toBe(true);
    }
    expect(await environments.status(workspace)).toMatchObject({
      ready: true,
      revision_id: ready.revision_id,
    });
  } finally {
    await store.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
