/**
 * Agent tools for remote compute. The control plane owns machine resolution,
 * execution records and provenance; these tools stay thin adapters plus the
 * in-conversation approval gate for anything that runs code on a remote host.
 */
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import type { InteractionBridge } from "./interaction-bridge.js";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;

const INTERNAL_TOKEN_HEADER = "x-pi-science-internal-token";
/** Keep tool output bounded for the conversation; the control plane keeps the full record. */
const MAX_PRESENTED_OUTPUT_CHARS = 32_768;

function backendBaseUrl(): string {
  return (process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

async function callBackend(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const token = process.env.PI_SCIENCE_INTERNAL_TOKEN;
  if (token) headers.set(INTERNAL_TOKEN_HEADER, token);
  const response = await fetch(`${backendBaseUrl()}${path}`, { ...init, headers, signal });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Control plane returned HTTP ${response.status}`);
  return body;
}

function presentOutput(value: string): string {
  if (value.length <= MAX_PRESENTED_OUTPUT_CHARS) return value;
  const head = value.slice(0, Math.floor(MAX_PRESENTED_OUTPUT_CHARS * 0.6));
  const tail = value.slice(-Math.floor(MAX_PRESENTED_OUTPUT_CHARS * 0.3));
  return `${head}\n… [output truncated; ${value.length} chars total; the full output is in the Runs view] …\n${tail}`;
}

function preview(value: string, max = 400): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export interface RemoteComputeTools {
  machines: Tool;
  execute: Tool;
  submit: Tool;
  check: Tool;
}

export function remoteComputeTools(cwd: string, interactions: InteractionBridge): RemoteComputeTools {
  const query = `cwd=${encodeURIComponent(cwd)}`;

  const machines: Tool = {
    name: "remote_machines",
    label: "Remote machines",
    description: "List compute machines registered for this workspace (Settings → Compute). Use this before remote_execute or slurm tools to discover machine labels. Registered machines use SSH key authentication.",
    parameters: Type.Object({}),
    async execute() {
      const body = await callBackend(`/api/compute/machines?${query}`);
      const rows = Array.isArray(body.machines) ? (body.machines as Array<Record<string, unknown>>) : [];
      const text = rows.length
        ? rows.map((row) => `- ${String(row.label ?? "")}: ${String(row.user ?? "")}@${String(row.host ?? "")}:${String(row.port ?? 22)} (${String(row.auth_method ?? "key")} auth)`).join("\n")
        : "No machines are registered for this workspace. Ask the user to add one in Settings → Compute (SSH host, port and key).";
      return { content: [{ type: "text", text }], details: { machines: rows.length } };
    },
  };

  const execute: Tool = {
    name: "remote_execute",
    label: "Remote execute",
    description: "Run a shell command on a registered remote machine over SSH and return its output. Use for remote inspection (nvidia-smi, module avail, ls) and for copying results back (cat a remote file into the conversation). Long-running work belongs on Slurm via slurm_submit. Timeout defaults to 300s (max 600s).",
    parameters: Type.Object({
      machine: Type.String({ description: "Machine label from remote_machines" }),
      command: Type.String({ description: "Shell command to run on the remote machine" }),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Command timeout in seconds (default 300)" })),
    }),
    async execute(toolCallId, params, _update, _ctx, _invocation, context) {
      const input = params as { machine: string; command: string; timeout_seconds?: number };
      const approved = await interactions.confirmPermission(
        `Allow remote execution on ${input.machine}`,
        `The agent wants to run this command on ${input.machine}:\n\n${preview(input.command)}`,
        context.abortSignal,
        toolCallId,
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Remote execution was not approved by the user." }], isError: true, details: { approved: false } };
      }
      const body = await callBackend(`/api/compute/execute?${query}`, {
        method: "POST",
        body: JSON.stringify({ machine_label: input.machine, command: input.command, timeout_seconds: input.timeout_seconds }),
      }, context.abortSignal);
      const exitCode = body.exitCode === null ? null : Number(body.exitCode);
      const durationMs = Number(body.durationMs ?? 0);
      const sections = [
        `exit_code: ${exitCode ?? "null"}${body.timedOut ? " (timed out)" : ""}${body.aborted ? " (aborted)" : ""}`,
        `duration_ms: ${durationMs}`,
      ];
      if (typeof body.stdout === "string" && body.stdout.length) sections.push(`stdout:\n${presentOutput(body.stdout)}`);
      if (typeof body.stderr === "string" && body.stderr.length) sections.push(`stderr:\n${presentOutput(body.stderr)}`);
      if (body.stdoutTruncated) sections.push("stdout was truncated in the execution record; query the remote file directly for the full content.");
      return { content: [{ type: "text", text: sections.join("\n") }], details: { execution_id: body.execution_id, exit_code: exitCode } };
    },
  };

  const submit: Tool = {
    name: "slurm_submit",
    label: "Slurm submit",
    description: "Submit a Slurm batch script on a registered remote machine. The script is transported safely and submitted with sbatch; output lands in slurm-<jobid>.out / .err in the remote login directory. Poll results with slurm_check.",
    parameters: Type.Object({
      machine: Type.String({ description: "Machine label from remote_machines" }),
      script: Type.String({ description: "Full sbatch script content, including #SBATCH directives" }),
      name: Type.Optional(Type.String({ description: "Short job name (letters, digits, dot, dash, underscore)" })),
    }),
    async execute(toolCallId, params, _update, _ctx, _invocation, context) {
      const input = params as { machine: string; script: string; name?: string };
      const approved = await interactions.confirmPermission(
        `Allow Slurm submission on ${input.machine}`,
        `The agent wants to submit this Slurm job on ${input.machine}:\n\n${preview(input.script)}`,
        context.abortSignal,
        toolCallId,
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Slurm submission was not approved by the user." }], isError: true, details: { approved: false } };
      }
      const body = await callBackend(`/api/compute/slurm-submit?${query}`, {
        method: "POST",
        body: JSON.stringify({ machine_label: input.machine, script: input.script, name: input.name }),
      }, context.abortSignal);
      const text = [
        `job_id: ${String(body.job_id ?? "?")}`,
        `state: submitted`,
        `output: ${String(body.output_path ?? "")} (remote login directory)`,
        `error: ${String(body.error_path ?? "")}`,
        "Poll with slurm_check; fetch results with remote_execute (cat) once finished.",
      ].join("\n");
      return { content: [{ type: "text", text }], details: { job_id: body.job_id, execution_id: body.execution_id } };
    },
  };

  const check: Tool = {
    name: "slurm_check",
    label: "Slurm check",
    description: "Check a Slurm job's state on a registered remote machine and, once it has finished, fetch bounded output tails from slurm-<jobid>.out/.err.",
    parameters: Type.Object({
      machine: Type.String({ description: "Machine label from remote_machines" }),
      job_id: Type.String({ description: "Numeric Slurm job id returned by slurm_submit" }),
      include_output: Type.Optional(Type.Boolean({ description: "Fetch output tails when the job has finished (default true)" })),
    }),
    async execute(_toolCallId, params, _update, _ctx, _invocation, context) {
      const input = params as { machine: string; job_id: string; include_output?: boolean };
      const body = await callBackend(`/api/compute/slurm-check?${query}`, {
        method: "POST",
        body: JSON.stringify({ machine_label: input.machine, job_id: input.job_id, include_output: input.include_output }),
      }, context.abortSignal);
      const sections = [
        `state: ${String(body.state ?? "unknown")} (${String(body.raw_state ?? "UNKNOWN")})`,
        body.exit_code ? `exit_code: ${String(body.exit_code)}` : null,
        body.elapsed ? `elapsed: ${String(body.elapsed)}` : null,
      ].filter((line): line is string => line !== null);
      if (typeof body.stdout_tail === "string" && body.stdout_tail.length) sections.push(`stdout (tail):\n${presentOutput(body.stdout_tail)}`);
      if (typeof body.stderr_tail === "string" && body.stderr_tail.length) sections.push(`stderr (tail):\n${presentOutput(body.stderr_tail)}`);
      if (body.state === "unknown") sections.push("The job is not in squeue and sacct returned nothing; it may be too old for accounting retention.");
      return { content: [{ type: "text", text: sections.join("\n") }], details: { state: body.state } };
    },
  };

  return { machines, execute, submit, check };
}
