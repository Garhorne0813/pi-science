import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

export interface WorkspaceEnvironmentStatus {
  ready: boolean;
  workspace: string;
  virtual_env: string;
  python: string;
  pip: string;
  npm: {
    local_prefix: string;
    global_prefix: string;
    cache: string;
  };
  error?: string;
}

function executablePaths(cwd: string) {
  const virtualEnv = join(resolve(cwd), ".venv");
  const bin = process.platform === "win32" ? join(virtualEnv, "Scripts") : join(virtualEnv, "bin");
  return {
    virtualEnv,
    bin,
    python: join(bin, process.platform === "win32" ? "python.exe" : "python"),
    pip: join(bin, process.platform === "win32" ? "pip.exe" : "pip"),
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true; }
  catch { return false; }
}

export class WorkspaceEnvironmentService {
  private readonly provisioning = new Map<string, Promise<WorkspaceEnvironmentStatus>>();

  constructor(private readonly basePython = process.env.PI_SCIENCE_PYTHON_EXECUTABLE || process.env.PYTHON || "python3") {}

  async status(cwdValue: string): Promise<WorkspaceEnvironmentStatus> {
    const workspace = resolve(cwdValue);
    const paths = executablePaths(workspace);
    const marker = join(paths.virtualEnv, "pyvenv.cfg");
    const ready = await exists(marker) && await executable(paths.python) && await executable(paths.pip);
    let error: string | undefined;
    if (!ready && await exists(paths.virtualEnv)) {
      try {
        const info = await stat(paths.virtualEnv);
        error = info.isDirectory()
          ? "The workspace .venv is incomplete. Remove or repair it before provisioning again."
          : "The workspace .venv path exists but is not a directory."
      } catch { /* raced with removal */ }
    }
    return {
      ready,
      workspace,
      virtual_env: paths.virtualEnv,
      python: paths.python,
      pip: paths.pip,
      npm: {
        local_prefix: workspace,
        global_prefix: join(workspace, ".pi-science", "npm-global"),
        cache: join(workspace, ".pi-science", "cache", "npm"),
      },
      ...(error ? { error } : {}),
    };
  }

  async ensure(cwdValue: string): Promise<WorkspaceEnvironmentStatus> {
    const cwd = resolve(cwdValue);
    const current = this.provisioning.get(cwd);
    if (current) return current;
    const operation = this.provision(cwd).finally(() => this.provisioning.delete(cwd));
    this.provisioning.set(cwd, operation);
    return operation;
  }

  async environment(cwdValue: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
    const status = await this.ensure(cwdValue);
    const paths = executablePaths(status.workspace);
    const npmBin = process.platform === "win32" ? status.npm.global_prefix : join(status.npm.global_prefix, "bin");
    const pnpmHome = join(status.workspace, ".pi-science", "pnpm-global");
    return {
      ...inherited,
      PATH: [paths.bin, npmBin, pnpmHome, inherited.PATH ?? ""].filter(Boolean).join(delimiter),
      VIRTUAL_ENV: status.virtual_env,
      PYTHONNOUSERSITE: "1",
      PIP_REQUIRE_VIRTUALENV: "1",
      PIP_USER: "0",
      UV_PROJECT_ENVIRONMENT: status.virtual_env,
      npm_config_prefix: status.npm.global_prefix,
      NPM_CONFIG_PREFIX: status.npm.global_prefix,
      npm_config_cache: status.npm.cache,
      NPM_CONFIG_CACHE: status.npm.cache,
      npm_config_update_notifier: "false",
      PNPM_HOME: pnpmHome,
      COREPACK_HOME: join(status.workspace, ".pi-science", "cache", "corepack"),
      PYTHONHOME: undefined,
      PIP_PREFIX: undefined,
    };
  }

  private async provision(cwd: string): Promise<WorkspaceEnvironmentStatus> {
    const before = await this.status(cwd);
    if (before.ready) return before;
    if (before.error) throw new Error(before.error);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(this.basePython, ["-m", "venv", join(cwd, ".venv")], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        killSignal: "SIGKILL",
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => done({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
    if (result.code !== 0) {
      await rm(join(cwd, ".venv"), { recursive: true, force: true });
      throw new Error(`Unable to create workspace Python environment with ${this.basePython}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }
    const after = await this.status(cwd);
    if (!after.ready) {
      await rm(join(cwd, ".venv"), { recursive: true, force: true });
      throw new Error("Python reported success but the workspace .venv is incomplete");
    }
    // Reading the marker catches an inaccessible or corrupt environment before
    // it is handed to an agent or kernel.
    await readFile(join(after.virtual_env, "pyvenv.cfg"), "utf8");
    return after;
  }
}
