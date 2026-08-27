import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookService } from "./notebook-service.js";
import type { WorkspaceEnvironmentStatus } from "../workspace/workspace-environment.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("NotebookService", () => {
  it("lists ipynb files while skipping dot directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-notebooks-"));
    cleanup.push(cwd);
    await writeFile(join(cwd, "a.ipynb"), "{}", "utf8");
    await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "nested", "b.ipynb"), "{}", "utf8");
    await mkdir(join(cwd, ".hidden"));
    await writeFile(join(cwd, ".hidden", "c.ipynb"), "{}", "utf8");

    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });
    const files = await service.list(cwd);
    expect(files.map((file) => file.path)).toEqual(["a.ipynb", "nested/b.ipynb"]);
  });

  it("reports jupyter env status and idle server state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-"));
    cleanup.push(cwd);
    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });

    expect((await service.envStatus(cwd)).ready).toBe(false);
    expect(service.status()).toMatchObject({ running: false, port: null, url: null });
  });

  it("installs the project kernel dependency before writing a kernelspec", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-kernelspec-"));
    cleanup.push(cwd);
    const prefix = join(cwd, "project-env");
    const bin = join(prefix, process.platform === "win32" ? "Scripts" : "bin");
    const python = join(bin, process.platform === "win32" ? "python.exe" : "python");
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(python, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(python, 0o755);
    const registryPath = join(cwd, ".pi-science", "environments", "registry.json");
    await mkdir(join(cwd, ".pi-science", "environments"), { recursive: true });
    await writeFile(registryPath, JSON.stringify({
      schema_version: 1,
      revisions: [{
        environment_id: "env_python", revision_id: "rev_python", name: "python", display_name: "Python",
        language: "python", status: "ready", prefix, packages: ["python=3.12", "pip"],
        platform: `${process.platform}-${process.arch}`, created_at: new Date().toISOString(),
      }],
    }), "utf8");
    await writeFile(join(cwd, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1, environment_id: "env_python", revision_id: "rev_python", bound_at: new Date().toISOString(),
    }), "utf8");

    const installPackages = vi.fn(async () => {
      const registry = JSON.parse(await readFile(registryPath, "utf8")) as { revisions: Array<{ packages: string[] }> };
      const revision = registry.revisions[0];
      if (!revision) throw new Error("test registry is empty");
      revision.packages.push("ipykernel");
      await writeFile(registryPath, JSON.stringify(registry), "utf8");
      return {
        ready: true, workspace: cwd, prefix, python, pip: join(bin, process.platform === "win32" ? "pip.exe" : "pip"),
        environment_id: "env_python", revision_id: "rev_python", manager: "micromamba",
        npm: { local_prefix: cwd, global_prefix: join(cwd, ".pi-science", "node-tools", "npm"), cache: join(cwd, ".pi-science", "cache", "npm") },
      } satisfies WorkspaceEnvironmentStatus;
    });
    const service = new NotebookService({
      configPath: (name) => join(cwd, ".pi-science", name),
      environments: { installPackages },
    });

    const installKernelspec = (service as unknown as { installProjectKernelspec: (workspace: string) => Promise<void> }).installProjectKernelspec.bind(service);
    await installKernelspec(cwd);

    expect(installPackages).toHaveBeenCalledWith(cwd, ["ipykernel"]);
    const kernel = JSON.parse(await readFile(join(service.jupyterPrefix, "share", "jupyter", "kernels", "pi-science-rev_python", "kernel.json"), "utf8")) as { argv: string[] };
    expect(kernel.argv).toEqual([python, "-m", "ipykernel_launcher", "-f", "{connection_file}"]);
  });

  it("uses prefix-root python.exe for a Windows project kernelspec when Scripts is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-windows-root-python-"));
    cleanup.push(cwd);
    const prefix = join(cwd, "project-env");
    const python = join(prefix, "python.exe");
    await mkdir(join(cwd, ".pi-science", "environments"), { recursive: true });
    await mkdir(prefix, { recursive: true });
    await writeFile(python, "", "utf8");
    await writeFile(join(cwd, ".pi-science", "environments", "registry.json"), JSON.stringify({
      schema_version: 1,
      revisions: [{
        environment_id: "env_python", revision_id: "rev_windows_root", name: "python", display_name: "Python",
        language: "python", status: "ready", prefix, packages: ["python=3.12", "pip", "ipykernel"],
        platform: "win32-x64", created_at: new Date().toISOString(),
      }],
    }), "utf8");
    await writeFile(join(cwd, ".pi-science", "environment.json"), JSON.stringify({
      schema_version: 1, environment_id: "env_python", revision_id: "rev_windows_root", bound_at: new Date().toISOString(),
    }), "utf8");

    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name), platform: "win32" });
    const installKernelspec = (service as unknown as { installProjectKernelspec: (workspace: string) => Promise<void> }).installProjectKernelspec.bind(service);
    await installKernelspec(cwd);

    const kernel = JSON.parse(await readFile(join(service.jupyterPrefix, "share", "jupyter", "kernels", "pi-science-rev_windows_root", "kernel.json"), "utf8")) as { argv: string[] };
    expect(kernel.argv).toEqual([python, "-m", "ipykernel_launcher", "-f", "{connection_file}"]);
  });

  it("rejects a second setup while one is already running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-setup-race-"));
    cleanup.push(cwd);
    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name), micromambaExecutable: join(cwd, "missing", "micromamba") });

    const first = service.setup(cwd);
    await expect(service.setup(cwd)).rejects.toThrow("Setup already in progress");
    // The first attempt fails because the injected micromamba binary does not exist; the slot must free up.
    await expect(first).resolves.toMatchObject({ status: "error" });
    await expect(service.setup(cwd)).resolves.toMatchObject({ status: "error" });
  });

  it("serializes concurrent starts so only one runs at a time", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-start-race-"));
    cleanup.push(cwd);
    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });
    await mkdir(dirname(service.jupyterBin), { recursive: true });
    await writeFile(service.jupyterBin, "", "utf8");
    let active = 0;
    let maxActive = 0;
    const spy = vi.spyOn(service as unknown as { installProjectKernelspec: (workspace: string) => Promise<void> }, "installProjectKernelspec")
      .mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        active -= 1;
        throw new Error("stop-here");
      });

    const results = await Promise.allSettled([service.start(cwd), service.start(cwd)]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect((result.reason as Error).message).toBe("stop-here");
    }
  });

  it("cancels an in-flight start when the service is stopped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-start-cancel-"));
    cleanup.push(cwd);
    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });
    await mkdir(dirname(service.jupyterBin), { recursive: true });
    await writeFile(service.jupyterBin, "", "utf8");

    let release!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      vi.spyOn(service as unknown as { installProjectKernelspec: (workspace: string) => Promise<void> }, "installProjectKernelspec")
        .mockImplementation(async () => {
          resolveEntered();
          await gate;
        });
    });

    const start = service.start(cwd);
    await entered;
    service.stop();
    release();

    await expect(start).rejects.toThrow("Jupyter start cancelled");
    expect(service.status()).toMatchObject({ running: false, port: null, url: null });
  });

  // The shim records Jupyter argv through a Node script, which cannot be
  // launched bare on win32; the boundary assertions below are POSIX-covered.
  it.skipIf(process.platform === "win32")("binds jupyter to the workspace root and fences cross-workspace control", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-jupyter-scope-"));
    cleanup.push(cwd);
    const other = await mkdtemp(join(tmpdir(), "pi-science-jupyter-other-"));
    cleanup.push(other);
    const record = join(cwd, "spawn-args.json");
    const service = new NotebookService({ configPath: (name) => join(cwd, ".pi-science", name) });
    await mkdir(dirname(service.jupyterBin), { recursive: true });
    await writeFile(service.jupyterBin, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nsetInterval(() => {}, 30_000);\n`, "utf8");
    await chmod(service.jupyterBin, 0o755);

    const started = await service.start(cwd);
    expect(started.running).toBe(true);
    // The shim boots asynchronously; wait for its argv record to land on disk.
    const args = await vi.waitFor(async () => JSON.parse(await readFile(record, "utf8")) as string[]);
    expect(args).toContain(`--ServerApp.root_dir=${resolve(cwd)}`);
    const tokenArg = args.find((item) => item.startsWith("--ServerApp.token="));
    expect(tokenArg).toBeDefined();
    expect(started.url).toBe(`http://127.0.0.1:${started.port}/lab?token=${tokenArg!.split("=")[1]}`);

    expect(service.status(other)).toMatchObject({ running: true, matches_workspace: false });
    expect(service.status(cwd)).toMatchObject({ running: true, matches_workspace: true });
    await expect(service.start(other)).rejects.toThrow("already running for another workspace");
    expect(() => service.stop(other)).toThrowError("Cannot stop Jupyter Lab owned by another workspace");

    expect(service.stop(cwd).running).toBe(false);
    expect(service.status()).toMatchObject({ running: false, port: null, url: null });
  });
});
