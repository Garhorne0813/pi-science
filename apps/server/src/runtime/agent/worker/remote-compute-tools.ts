/**
 * Agent tools for remote compute. The control plane owns machine resolution,
 * execution records and provenance; these tools stay thin adapters plus the
 * in-conversation approval gate for anything that runs code on a remote host.
 */
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import { MAX_COMMAND_CHARS, MAX_SCRIPT_CHARS, RECORD_STDERR_CHARS, RECORD_STDOUT_CHARS } from "../../compute/remote-compute-service.js";
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
  return `${head}\n… [output truncated for the conversation; ${value.length} chars total. Runs keeps only a bounded preview (first ${RECORD_STDOUT_CHARS / 1024} KiB of stdout, ${RECORD_STDERR_CHARS / 1024} KiB of stderr); run a narrower remote command for the rest] …\n${tail}`;
}

function stopNote(body: Record<string, unknown>): string | null {
  if (!body.timedOut && !body.aborted) return null;
  return body.remoteStop === "confirmed"
    ? "The remote watchdog stopped the remote process group."
    : "Only the local SSH client was stopped; the remote process may still be running. Check the machine before reusing its files.";
}

export interface RemoteComputeTools {
  machines: Tool;
  execute: Tool;
  submit: Tool;
  check: Tool;
}

export function remoteComputeTools(cwd: string, interactions: InteractionBridge, sessionId?: string): RemoteComputeTools {
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
    description: "Run a shell command on a registered remote machine over SSH and return its output. Use for remote inspection (nvidia-smi, module avail, ls) and for copying results back (cat a remote file into the conversation). Long-running work belongs on Slurm via slurm_submit. The deadline is enforced on the remote host, which stops the command's process group. Timeout defaults to 300s (max 600s).",
    parameters: Type.Object({
      machine: Type.String({ description: "Machine label from remote_machines" }),
      command: Type.String({ description: "Shell command to run on the remote machine" }),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "Command timeout in seconds (default 300)" })),
    }),
    async execute(toolCallId, params, _update, _ctx, invocation, context) {
      const input = params as { machine: string; command: string; timeout_seconds?: number };
      const command = String(input.command ?? "");
      if (!command.trim()) throw new Error("command is required");
      if (command.length > MAX_COMMAND_CHARS) throw new Error(`command exceeds ${MAX_COMMAND_CHARS} characters`);
      const approved = await interactions.confirmPermission(
        `Allow remote execution on ${input.machine}`,
        `The agent wants to run this command on ${input.machine}. The complete command is below; approve only if all of it is expected.\n\n${command}`,
        context.abortSignal,
        toolCallId,
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Remote execution was not approved by the user." }], isError: true, details: { approved: false } };
      }
      const body = await callBackend(`/api/compute/execute?${query}`, {
        method: "POST",
        body: JSON.stringify({ machine_label: input.machine, command, timeout_seconds: input.timeout_seconds, session_id: sessionId, tool_call_id: toolCallId, operation_id: invocation.operationId }),
      }, context.abortSignal);
      const exitCode = body.exitCode === null ? null : Number(body.exitCode);
      const durationMs = Number(body.durationMs ?? 0);
      const sections = [
        `exit_code: ${exitCode ?? "null"}${body.timedOut ? " (timed out)" : ""}${body.aborted ? " (aborted)" : ""}`,
        `duration_ms: ${durationMs}`,
      ];
      const stopped = stopNote(body);
      if (stopped) sections.push(stopped);
      if (typeof body.stdout === "string" && body.stdout.length) sections.push(`stdout:\n${presentOutput(body.stdout)}`);
      if (typeof body.stderr === "string" && body.stderr.length) sections.push(`stderr:\n${presentOutput(body.stderr)}`);
      if (body.stdoutTruncated) sections.push("stdout exceeded the capture limit; query the remote file directly for the full content.");
      return { content: [{ type: "text", text: sections.join("\n") }], details: { execution_id: body.execution_id, exit_code: exitCode, remote_stop: body.remoteStop } };
    },
  };

  const submit: Tool = {
    name: "slurm_submit",
    label: "Slurm submit",
    description: "Submit a Slurm batch script on a registered remote machine. A zero exit means the scheduler accepted the submission, not that the job succeeded. Output paths are absolute under the submission directory, so #SBATCH --chdir does not move them. Array jobs (--array) are rejected. Poll results with slurm_check.",
    parameters: Type.Object({
      machine: Type.String({ description: "Machine label from remote_machines" }),
      script: Type.String({ description: "Full sbatch script content, including #SBATCH directives" }),
      name: Type.Optional(Type.String({ description: "Short job name (letters, digits, dot, dash, underscore)" })),
    }),
    async execute(toolCallId, params, _update, _ctx, invocation, context) {
      const input = params as { machine: string; script: string; name?: string };
      const script = String(input.script ?? "");
      if (!script.trim()) throw new Error("script is required");
      if (script.length > MAX_SCRIPT_CHARS) throw new Error(`script exceeds ${MAX_SCRIPT_CHARS} characters`);
      if (/^\s*#SBATCH[^\n]*--array\b/im.test(script)) throw new Error("Array jobs (#SBATCH --array) are not supported: slurm_check reports and records one job at a time. Submit one job per call.");
      const approved = await interactions.confirmPermission(
        `Allow Slurm submission on ${input.machine}`,
        `The agent wants to submit this Slurm job on ${input.machine}. The complete script is below; approve only if all of it is expected.\n\n${script}`,
        context.abortSignal,
        toolCallId,
      );
      if (!approved) {
        return { content: [{ type: "text", text: "Slurm submission was not approved by the user." }], isError: true, details: { approved: false } };
      }
      const body = await callBackend(`/api/compute/slurm-submit?${query}`, {
        method: "POST",
        body: JSON.stringify({ machine_label: input.machine, script, name: input.name, session_id: sessionId, tool_call_id: toolCallId, operation_id: invocation.operationId }),
      }, context.abortSignal);
      const text = [
        `job_id: ${String(body.job_id ?? "?")}`,
        "state: submitted (accepted by the scheduler; the job has not run to completion)",
        `output: ${String(body.output_path ?? "")}`,
        `error: ${String(body.error_path ?? "")}`,
        "Poll with slurm_check; fetch results with remote_execute (cat) once finished.",
      ].join("\n");
      return { content: [{ type: "text", text }], details: { job_id: body.job_id, execution_id: body.execution_id, job_execution_id: body.job_execution_id } };
    },
  };

  const check: Tool = {
    name: "slurm_check",
    label: "Slurm check",
    description: "Check a Slurm job's state on a registered remote machine and, once it has finished, fetch bounded output tails. Array elements and accounting steps are aggregated, so a failed element is reported as a failure. Connection and scheduler errors are reported as errors, not as an unknown job.",
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
        typeof body.output_path === "string" ? `output: ${body.output_path}` : null,
      ].filter((line): line is string => line !== null);
      if (typeof body.stdout_tail === "string" && body.stdout_tail.length) sections.push(`stdout (tail):\n${presentOutput(body.stdout_tail)}`);
      if (typeof body.stderr_tail === "string" && body.stderr_tail.length) sections.push(`stderr (tail):\n${presentOutput(body.stderr_tail)}`);
      if (body.query_status === "no_records") sections.push("Neither squeue nor sacct returned a record: the job id may be wrong, or the job is older than the scheduler's accounting retention. This is not evidence that the job never ran.");
      return { content: [{ type: "text", text: sections.join("\n") }], details: { state: body.state, job_execution_id: body.job_execution_id } };
    },
  };

  return { machines, execute, submit, check };
}
