import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { configPath } from "../../storage/persistence.js";
import type { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";

export interface NotebookFile {
  path: string;
  name: string;
  size: number;
  modified: string;
}

export interface JupyterSetupEvent {
  status: "progress" | "error" | "done";
  text: string;
}

export interface JupyterEnvStatus {
  ready: boolean;
  path: string;
  manager: "micromamba" | "unavailable";
}

export interface JupyterStatusPayload {
  running: boolean;
  port: number | null;
  url: string | null;
  cwd: string | null;
  env_ready?: boolean;
  matches_workspace: boolean;
  message?: string;
}

export interface NotebookServiceDependencies {
  configPath?: typeof configPath;
  platform?: NodeJS.Platform;
  micromambaExecutable?: string;
  environments?: Pick<WorkspaceEnvironmentService, "installPackages">;
  now?: () => Date;
}

async function pathExists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.listen(0, "127.0.0.1");
  });
}

function packageName(spec: string): string {
  return spec.trim().toLowerCase().match(/^[^<>=!\[\s]+/)?.[0] ?? "";
}

function hasPackage(packages: unknown, name: string): boolean {
  return Array.isArray(packages)
    && packages.some((item) => typeof item === "string" && packageName(item) === name);
}

export class NotebookService {
  private readonly configPath: (name: string) => string;
  private readonly platform: NodeJS.Platform;
  private readonly micromamba?: string;
  private readonly environments?: Pick<WorkspaceEnvironmentService, "installPackages">;
  readonly jupyterPrefix: string;
  readonly jupyterBin: string;
  private jupyterProcess?: ChildProcess;
  private jupyterPort: number | null = null;
  private jupyterCwd: string | null = null;
  private jupyterToken: string | null = null;
  private setupInProgress = false;
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: NotebookServiceDependencies = {}) {
    this.configPath = deps.configPath ?? configPath;
    this.platform = deps.platform ?? process.platform;
    this.environments = deps.environments;
    const prefix = this.configPath(join("micromamba", "envs", "pi-science-jupyter-runtime"));
    this.jupyterPrefix = prefix;
    const binDir = join(prefix, this.platform === "win32" ? "Scripts" : "bin");
    this.jupyterBin = join(binDir, this.platform === "win32" ? "jupyter-lab.exe" : "jupyter-lab");
    this.micromamba = deps.micromambaExecutable ?? process.env.PI_SCIENCE_MICROMAMBA_EXECUTABLE ?? this.managedMicromamba() ?? "micromamba";
  }

  private managedMicromamba(): string | undefined {
    const candidate = this.configPath(join("micromamba", "bin", this.platform === "win32" ? "micromamba.exe" : "micromamba"));
    return existsSync(candidate) ? candidate : undefined;
  }

  async list(cwd: string): Promise<NotebookFile[]> {
    const root = resolve(cwd);
    const out: NotebookFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ipynb")) {
          const info = await stat(full);
          out.push({
            path: full.slice(root.length + 1).split(sep).join("/"),
            name: entry.name,
            size: info.size,
            modified: info.mtime.toISOString(),
          });
        }
      }
    };
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async envStatus(_cwd: string): Promise<JupyterEnvStatus> {
    const ready = await pathExists(this.jupyterBin);
    const manager = this.micromamba && this.micromamba !== "unavailable" ? "micromamba" : "unavailable";
    return { ready, path: this.jupyterPrefix, manager };
  }

  async setup(cwd: string, onEvent?: (event: JupyterSetupEvent) => void): Promise<JupyterSetupEvent> {
    if (this.setupInProgress) throw new Error("Setup already in progress");
    const micromamba = this.micromamba;
    if (!micromamba || micromamba === "unavailable") throw new Error("Micromamba runtime is unavailable");
    // Claim the slot before the first await so concurrent callers cannot both pass the check.
    this.setupInProgress = true;
    try {
      const prefix = this.jupyterPrefix;
      await mkdir(join(prefix, ".."), { recursive: true });
      const emit = (status: JupyterSetupEvent["status"], text: string) => {
        const event: JupyterSetupEvent = { status, text };
        onEvent?.(event);
      };
      emit("progress", "Creating application Jupyter runtime...");
      const result = await this.run(
        micromamba,
        ["create", "--yes", "--prefix", prefix, "--channel", "conda-forge", "--strict-channel-priority", "python=3.12", "jupyterlab"],
        15 * 60_000,
        this.micromambaEnvironment(),
      );
      if (result.code !== 0) {
        const message = result.output.slice(-300) || `micromamba exited with ${result.code}`;
        emit("error", message);
        return { status: "error", text: message };
      }
      const done: JupyterSetupEvent = { status: "done", text: "Jupyter environment ready" };
      onEvent?.(done);
      return done;
    } finally {
      this.setupInProgress = false;
    }
  }

  status(cwd?: string): JupyterStatusPayload {
    const running = Boolean(this.jupyterProcess && this.jupyterProcess.exitCode === null);
    const payload: JupyterStatusPayload = {
      running,
      port: running ? this.jupyterPort : null,
      url: running && this.jupyterPort && this.jupyterToken ? `http://127.0.0.1:${this.jupyterPort}/lab?token=${this.jupyterToken}` : null,
      cwd: running ? this.jupyterCwd : null,
      matches_workspace: !running || cwd === undefined || this.jupyterCwd === resolve(cwd),
    };
    return payload;
  }

  /** Starts are serialized so two concurrent requests cannot spawn competing Jupyter processes. */
  start(cwd: string): Promise<JupyterStatusPayload> {
    const run = this.startQueue.then(() => this.startUnlocked(cwd), () => this.startUnlocked(cwd));
    this.startQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async startUnlocked(cwd: string): Promise<JupyterStatusPayload> {
    const workspace = resolve(cwd);
    if (!(await pathExists(workspace))) throw new Error(`Workspace directory does not exist: ${workspace}`);
    if (this.jupyterProcess && this.jupyterProcess.exitCode === null) {
      if (this.jupyterCwd === workspace) return { ...this.status(), message: "Already running" };
      throw new Error(`Jupyter Lab is already running for another workspace: ${this.jupyterCwd ?? "unknown"}`);
    }
    this.stop();
    if (!(await pathExists(this.jupyterBin))) throw new Error("The application Jupyter runtime is not installed");
    await this.installProjectKernelspec(workspace);
    this.jupyterPort = await findAvailablePort();
    this.jupyterCwd = workspace;
    this.jupyterToken = randomBytes(24).toString("hex");
    const jupyter = spawn(
      this.jupyterBin,
      [
        "--no-browser",
        "--ip=127.0.0.1",
        `--port=${this.jupyterPort}`,
        "--port-retries=0",
        `--ServerApp.root_dir=${workspace}`,
        `--ServerApp.token=${this.jupyterToken}`,
      ],
      { stdio: "ignore", env: this.micromambaEnvironment() },
    );
    this.jupyterProcess = jupyter;
    jupyter.once("exit", () => {
      if (this.jupyterProcess !== jupyter) return;
      this.jupyterProcess = undefined;
      this.jupyterPort = null;
      this.jupyterCwd = null;
      this.jupyterToken = null;
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));
    if (jupyter.exitCode !== null) {
      this.stop();
      throw new Error("Jupyter Lab exited during startup");
    }
    return this.status();
  }

  stop(cwd?: string): JupyterStatusPayload {
    if (cwd !== undefined && this.jupyterProcess && this.jupyterProcess.exitCode === null && this.jupyterCwd !== resolve(cwd)) {
      throw new Error("Cannot stop Jupyter Lab owned by another workspace");
    }
    const process = this.jupyterProcess;
    if (process && process.exitCode === null) {
      process.kill("SIGTERM");
      try { process.kill("SIGKILL"); } catch { /* best effort */ }
    }
    this.jupyterProcess = undefined;
    this.jupyterPort = null;
    this.jupyterCwd = null;
    this.jupyterToken = null;
    return { running: false, port: null, url: null, cwd: null, matches_workspace: true };
  }

  async shutdown(): Promise<void> {
    this.stop();
  }

  private async installProjectKernelspec(workspace: string, allowDependencyInstall = true): Promise<void> {
    const bindingPath = join(workspace, ".pi-science", "environment.json");
    let binding: { environment_id?: unknown; revision_id?: unknown };
    try {
      binding = JSON.parse(await readFile(bindingPath, "utf8")) as typeof binding;
    } catch {
      return;
    }
    if (typeof binding.revision_id !== "string") return;
    let registry: { revisions?: Array<Record<string, unknown>> };
    try {
      registry = JSON.parse(await readFile(this.configPath(join("environments", "registry.json")), "utf8")) as typeof registry;
    } catch {
      return;
    }
    const revision = registry.revisions?.find((item) => item.revision_id === binding.revision_id && item.status === "ready");
    if (!revision || typeof revision.prefix !== "string") return;
    const prefix = revision.prefix as string;
    const binDir = join(prefix, this.platform === "win32" ? "Scripts" : "bin");
    const language = typeof revision.language === "string" ? revision.language : "python";
    const kernelPackage = language === "r" ? "r-irkernel" : "ipykernel";
    if (!hasPackage(revision.packages, kernelPackage)) {
      if (!allowDependencyInstall || !this.environments) {
        throw new Error(`The ${language} environment must include ${kernelPackage} before a Jupyter kernelspec can be created`);
      }
      await this.environments.installPackages(workspace, [kernelPackage]);
      return this.installProjectKernelspec(workspace, false);
    }
    const displayName = typeof revision.display_name === "string" ? revision.display_name : "Pi-Science Project";
    const executable = language === "r"
      ? join(binDir, this.platform === "win32" ? "R.exe" : "R")
      : join(binDir, this.platform === "win32" ? "python.exe" : "python");
    if (!(await pathExists(executable))) return;
    const kernelDir = join(this.jupyterPrefix, "share", "jupyter", "kernels", `pi-science-${binding.revision_id.toLowerCase()}`);
    await mkdir(kernelDir, { recursive: true });
    const argv = language === "r"
      ? [executable, "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"]
      : [executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"];
    await writeFile(
      join(kernelDir, "kernel.json"),
      JSON.stringify({
        argv,
        display_name: `${displayName} (${binding.revision_id.slice(0, 12)})`,
        language,
        metadata: { pi_science_environment_revision_id: binding.revision_id },
      }, null, 2) + "\n",
      "utf8",
    );
  }

  private micromambaEnvironment(): NodeJS.ProcessEnv {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
      const normalized = key.toUpperCase();
      return normalized !== "VIRTUAL_ENV"
        && normalized !== "UV_PROJECT_ENVIRONMENT"
        && normalized !== "CONDA_DEFAULT_ENV"
        && normalized !== "CONDA_EXE"
        && normalized !== "CONDA_PYTHON_EXE"
        && normalized !== "CONDA_SHLVL"
        && normalized !== "CONDA_PROMPT_MODIFIER"
        && normalized !== "CONDARC"
        && normalized !== "MAMBARC"
        && normalized !== "MAMBA_ROOT_PREFIX"
        && normalized !== "MAMBA_EXE"
        && !/^CONDA_PREFIX(?:_\d+)?$/.test(normalized);
    }));
    environment.MAMBA_ROOT_PREFIX = this.configPath("micromamba");
    environment.MAMBA_NO_RC = "true";
    return environment;
  }

  private run(command: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; output: string }> {
    return new Promise((done) => {
      const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("error", () => { clearTimeout(timer); done({ code: -1, output: Buffer.concat(output).toString("utf8") }); });
      child.once("close", (code) => { clearTimeout(timer); done({ code, output: Buffer.concat(output).toString("utf8") }); });
    });
  }
}
