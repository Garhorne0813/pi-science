// PiJsonRunner (docs §9.9): one-shot strict-JSON summarization over an
// isolated Pi session with ALL agency disabled. Capability-granting arguments
// are stripped and the three disable flags are force-appended — no tools, no
// extensions, no skills and therefore no bash/web/file egress is a release
// gate for scheduled tasks (verified against the bundled Pi Orbit CLI:
// --no-tools/--no-extensions/--no-skills exist in runtime/pi docs/usage.md).
// The prompt is NOT the security boundary.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { metadataRoot } from "../storage/persistence.js";
import { piManager } from "../runtime/pi/pi-manager.js";
import type { PiEvent, PiProcessOptions } from "../runtime/pi/pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../runtime/pi/pi-runtime-launch.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
/** Accumulated assistant-text budget (docs §9.9): 2 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Flags that would hand tools/extensions/skills to the runtime; each takes one value. */
const CAPABILITY_FLAGS = new Set(["--skill", "-e", "--extension"]);

/** Strip capability-granting flag/value pairs, then append the disable flags. */
export function withoutToolCapabilityArgs(args: string[]): string[] {
  const cleaned: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (CAPABILITY_FLAGS.has(arg)) {
      index += 1; // drop the flag together with its value
      continue;
    }
    cleaned.push(arg);
  }
  return [...cleaned, "--no-tools", "--no-extensions", "--no-skills"];
}

/** Structural process surface used here; PiProcess satisfies it, tests may fake it. */
export interface PiProcessLike {
  on(event: "event", listener: (event: PiEvent) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
  removeAllListeners(event?: string): unknown;
  sendCommand(type: string, params?: Record<string, unknown>): Promise<{ success?: boolean; error?: string | null }>;
}

/** Structural manager surface used here; PiManager satisfies it, tests may fake it. */
export interface PiManagerLike {
  start(managerKey: string, options: PiProcessOptions): Promise<PiProcessLike>;
  stop(managerKey: string): Promise<void>;
}

export interface PiJsonRunnerDeps {
  manager?: PiManagerLike;
  environments?: Pick<WorkspaceEnvironmentService, "environment">;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface PiJsonRunRequest {
  /** Deterministic key (docs §9.9: the attempt ID); also names the session dir. */
  managerKey: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PiJsonRunResult {
  text: string;
  parsed: unknown;
  usage: { model_tokens: number; cost_usd: number };
}

export class PiJsonRunner {
  private readonly maxResponseBytes: number;

  constructor(private readonly deps: PiJsonRunnerDeps = {}) {
    this.maxResponseBytes = Math.max(1, deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
  }

  async run(cwd: string, request: PiJsonRunRequest): Promise<PiJsonRunResult> {
    const timeoutMs = request.timeoutMs ?? this.deps.timeoutMs ?? 600_000;
    const manager = this.deps.manager ?? piManager;
    // Wall-clock budget covers startup too (docs §9.9): armed before any await
    // so a hung launch cannot outlive the attempt budget. rejectTurn points at
    // the in-flight turn once one exists; before that, stop() unwinds startup.
    let settleTurn: (() => void) | null = null;
    let rejectTurn: ((error: Error) => void) | null = null;
    let timedOut = false;
    const wallTimer = setTimeout(() => {
      timedOut = true;
      rejectTurn?.(new Error(`scheduled Pi run timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    wallTimer.unref?.();
    // Isolated session dir per scheduled run key (docs §9.9).
    const sessionDir = join(metadataRoot(cwd), "scheduled-sessions", request.managerKey);
    await mkdir(sessionDir, { recursive: true });
    const environment = this.deps.environments ? await this.deps.environments.environment(cwd) : {};
    const options = buildPiProcessOptions(cwd, loadDefaultPiConfig(), undefined, environment, sessionDir);
    if (!options) throw new Error("Pi CLI is not configured (PI_CLI_PATH missing)");
    // Release-gate hardening: strip any capability grant, then force-disable tools.
    options.args = withoutToolCapabilityArgs(options.args);
    if (options.web) options.web.runtime.skillPolicy = { mode: "none" };
    options.requestTimeoutMs = Math.max(30_000, timeoutMs);

    const process = await manager.start(request.managerKey, options);
    const usage = { model_tokens: 0, cost_usd: 0 };
    let text = "";

    const onEvent = (event: PiEvent): void => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        const kind = String(update?.type ?? "");
        if (kind === "text_delta" || kind === "text") {
          text += String(update?.delta ?? update?.text ?? update?.content ?? "");
          if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
            rejectTurn?.(new Error(`scheduled Pi JSON response exceeds ${this.maxResponseBytes} bytes`));
          }
        }
      }
      // Usage accumulates on every finished message so even a failed run reports spend.
      if (event.type === "message_end") {
        const messageUsage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
        usage.model_tokens += Number(messageUsage?.input ?? 0) + Number(messageUsage?.output ?? 0);
        usage.cost_usd += Number((messageUsage?.cost as Record<string, unknown> | undefined)?.total ?? 0);
      }
      if (event.type === "agent_settled") settleTurn?.();
    };
    const onExit = (): void => rejectTurn?.(new Error("scheduled Pi process exited before completing"));
    const onAbort = (): void => {
      // Dispose the managed runtime first so a cancelled attempt never keeps a live process.
      void manager.stop(request.managerKey).catch(() => undefined);
      rejectTurn?.(new Error("scheduled Pi run aborted"));
    };

    process.on("event", onEvent);
    process.once("exit", onExit);
    if (request.signal) request.signal.addEventListener("abort", onAbort, { once: true });

    const sendTurn = async (message: string): Promise<void> => {
      text = "";
      const settled = new Promise<void>((resolveTurn, rejectWithTurn) => {
        settleTurn = resolveTurn;
        rejectTurn = rejectWithTurn;
      });
      const acknowledged = await process.sendCommand("prompt", { message });
      if (!acknowledged.success) throw new Error(String(acknowledged.error ?? "scheduled Pi runtime rejected the prompt"));
      await settled;
    };

    try {
      // A timeout that fired during startup unwinds here so the finally below
      // still disposes the runtime (docs §8.6: cancelled attempts are cleaned up).
      if (timedOut) throw new Error(`scheduled Pi run timed out after ${timeoutMs} ms`);
      const state = await process.sendCommand("get_state");
      if (!state.success) throw new Error(String(state.error ?? "unable to initialize scheduled Pi runtime"));
      await sendTurn(`${request.systemPrompt}\n\n${request.userPrompt}`);
      let response = text;
      let parsed: unknown;
      try {
        parsed = parseJsonObject(response);
      } catch (error) {
        // Exactly one bounded repair retry (docs §9.9); a second failure propagates.
        await sendTurn(`Your previous response was not valid JSON. Repair it and return ONLY the corrected JSON object with no markdown and no commentary. Validation error: ${String(error).slice(0, 500)}`);
        response = text;
        parsed = parseJsonObject(response);
      }
      return { text: response, parsed, usage };
    } finally {
      clearTimeout(wallTimer);
      process.removeAllListeners("event");
      process.removeListener("exit", onExit);
      request.signal?.removeEventListener("abort", onAbort);
      await manager.stop(request.managerKey).catch(() => undefined);
    }
  }
}

/** Strict JSON extraction: direct parse, then markdown-fence strip, then the
 * widest {...} window — mirroring the research-loop supervisor runner. */
function parseJsonObject(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to bounded extraction */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("scheduled Pi runtime did not return JSON");
  return JSON.parse(trimmed.slice(start, end + 1));
}
