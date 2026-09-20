/** Routes Pi's Bash tool and direct ! commands through the Node sandbox job. */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const TOKEN_HEADER = "x-pi-science-internal-token";
const POLL_MS = 250;
const MAX_OUTPUT_CHARS = 50_000;

interface Job {
  job_id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  return_code?: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
}

function baseUrl(): string {
  return (process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

async function jobRequest(path: string, init: RequestInit = {}): Promise<Job> {
  const headers = new Headers(init.headers);
  const token = process.env.PI_SCIENCE_INTERNAL_TOKEN;
  if (token) headers.set(TOKEN_HEADER, token);
  const response = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  const payload = await response.json() as Job & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Sandbox request failed (${response.status})`);
  return payload;
}

function identity(env?: NodeJS.ProcessEnv): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ["PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_SESSION_ID"]) {
    if (typeof env?.[key] === "string") safe[key] = env[key]!;
  }
  return safe;
}

function terminal(status: Job["status"]): boolean {
  return status !== "pending" && status !== "running";
}

function output(job: Job): string {
  const combined = `${job.stdout ?? ""}${job.stderr ? `${job.stdout ? "\n" : ""}${job.stderr}` : ""}`;
  const tail = combined.length > MAX_OUTPUT_CHARS ? combined.slice(-MAX_OUTPUT_CHARS) : combined;
  return `${combined.length > MAX_OUTPUT_CHARS || job.stdout_truncated || job.stderr_truncated ? "[Output truncated]\n" : ""}${tail}`;
}

async function executeSandboxed(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null }> {
  if (options.signal?.aborted) throw new Error("aborted");
  const query = `cwd=${encodeURIComponent(cwd)}`;
  const job = await jobRequest(`/api/jobs/conversation?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, timeout_seconds: options.timeout ?? 3600, env: identity(options.env) }),
  });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void jobRequest(`/api/jobs/${encodeURIComponent(job.job_id)}?${query}`, { method: "DELETE" }).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    let current = job;
    while (!terminal(current.status)) {
      if (cancelled) throw new Error("aborted");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      current = await jobRequest(`/api/jobs/${encodeURIComponent(job.job_id)}?${query}`);
    }
    if (cancelled || current.status === "cancelled") throw new Error("aborted");
    const text = output(current);
    if (text) options.onData(Buffer.from(text));
    if (current.status === "timed_out") throw new Error(`timeout:${options.timeout ?? 3600}`);
    return { exitCode: current.return_code ?? (current.status === "succeeded" ? 0 : 1) };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function fileToolPathAllowed(workspace: string, cwd: string, path: unknown): Promise<boolean> {
  if (typeof path !== "string") return false;
  const value = path.startsWith("@") ? path.slice(1) : path;
  if (!value || value.includes("\0")) return false;
  const root = await realpath(workspace);
  const target = resolve(cwd, value);
  if (!within(resolve(workspace), target) && !within(root, target)) return false;
  const canonical = await canonicalPath(target);
  if (!within(root, canonical)) return false;
  return !relative(root, canonical).split(/[\\/]/).some((part) => part.toLowerCase() === ".pi-science");
}

export default function registerSandbox(pi: any): void {
  const cwd = process.env.PI_WORKSPACE_DIR || process.cwd();
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Execute a Bash command in the current workspace sandbox. Returns stdout and stderr.",
    promptSnippet: "Execute Bash commands in the workspace sandbox",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: { command: { type: "string" }, timeout: { type: "number", minimum: 1, maximum: 3600 } },
    },
    async execute(_id: string, params: { command: string; timeout?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      let text = "";
      const env = { PI_PROVIDER: ctx?.model?.provider, PI_MODEL: ctx?.model?.id, PI_REASONING_LEVEL: ctx?.thinkingLevel, PI_SESSION_ID: ctx?.sessionManager?.getSessionId?.() };
      const result = await executeSandboxed(params.command, ctx?.cwd || cwd, { onData: (chunk) => { text += chunk.toString(); }, signal, timeout: params.timeout, env });
      if (result.exitCode !== 0) throw new Error(`${text}${text ? "\n\n" : ""}Command exited with code ${result.exitCode}`);
      return { content: [{ type: "text", text }], details: { sandboxed: true } };
    },
  });
  pi.on("user_bash", () => ({ operations: { exec: executeSandboxed } }));
  pi.on("tool_call", async (event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd?: string }) => {
    if (!FILE_TOOLS.has(event.toolName)) return;
    const currentCwd = ctx.cwd || cwd;
    const path = event.input.path ?? currentCwd;
    try {
      if (!(await fileToolPathAllowed(cwd, currentCwd, path))) return { block: true, reason: "File tools are limited to workspace files outside .pi-science" };
      if (event.toolName === "find" && typeof event.input.pattern === "string") {
        const pattern = event.input.pattern;
        if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..") || pattern.split(/[\\/]/).some((part) => part.toLowerCase() === ".pi-science")) {
          return { block: true, reason: "Search pattern escapes the workspace" };
        }
      }
    } catch {
      return { block: true, reason: "Could not verify the file path inside the workspace" };
    }
  });
}
