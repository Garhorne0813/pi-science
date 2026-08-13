/** AI session-title generation (batch F, plan 1: Pi background agent).
 *
 *  Node orchestrates an isolated Pi Orbit runtime: it seeds the runtime with
 *  the latest conversation excerpt, sends one prompt asking for a short
 *  title, polls the runtime for its assistant reply, cleans the text and
 *  disposes the runtime. The real LLM call is performed by the Pi runtime
 *  with the user's configured provider — Node never speaks provider
 *  protocols, matching the architecture boundary.
 *
 *  The runtime is a fresh, empty Pi session, so the first assistant text
 *  produced by the title prompt is the reply we want (nothing else can
 *  appear before it).
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PiManager } from "../pi/pi-manager.js";
import type { PiResult } from "../pi/pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../pi/pi-runtime-launch.js";
import { sessionRepository } from "../node/session-repository.js";
import { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { AI_TITLE_PROMPT_INSTRUCTION } from "./title-prompt.js";

/** Minimum runtime surface the title service needs; tests provide a fake. */
export interface TitleRuntime {
  sendCommand(type: string, params?: Record<string, unknown>): Promise<PiResult>;
  dispose(): Promise<void>;
}

/** Production factory: a real Pi Orbit runtime via PiManager. */
export class PiTitleRuntimeFactory {
  private readonly environments: WorkspaceEnvironmentService;

  constructor(
    private readonly manager: PiManager,
    environments?: WorkspaceEnvironmentService,
  ) {
    // Injectable for tests: the real service provisions a python venv in the
    // workspace (spawn python -m venv), which is far too slow for CI units
    // that only verify dispose routing.
    this.environments = environments ?? new WorkspaceEnvironmentService();
  }

  async start(cwd: string): Promise<TitleRuntime> {
    const config = loadDefaultPiConfig();
    const environment = await this.environments.environment(cwd);
    // Pi Orbit can persist dynamically-created web runtimes even when
    // the host was launched with --no-session. Give title generation its own
    // disposable session directory so those implementation conversations can
    // never enter the user-facing `.pi-science/sessions` index.
    const temporaryRoot = join(cwd, ".pi-science", "title-runtimes");
    await mkdir(temporaryRoot, { recursive: true });
    const temporarySessionDir = await mkdtemp(join(temporaryRoot, "runtime-"));
    const options = buildPiProcessOptions(cwd, config, undefined, environment, temporarySessionDir);
    if (!options) {
      await rm(temporarySessionDir, { recursive: true, force: true });
      throw new Error("PI_CLI_PATH is not configured");
    }
    // Keep the manager key so dispose can go through manager.stop(key): a raw
    // process.shutdown() would leave the entry in the manager's processes map
    // forever (web runtimes are detached, so no exit event fires) and the map
    // would grow without bound across title generations.
    const key = randomUUID();
    try {
      const process = await this.manager.start(key, options);
      return {
        sendCommand: (type, params = {}) => process.sendCommand(type, params),
        dispose: async () => {
          try {
            await this.manager.stop(key);
          } finally {
            await rm(temporarySessionDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(temporarySessionDir, { recursive: true, force: true });
      throw error;
    }
  }
}

// Aligned with the client-side setSessionName cap (frontend session-names.ts
// slices to 50); anything longer can never be displayed verbatim.
const MAX_TITLE_LENGTH = 50;
const PROMPT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_PAGE = 40;
const MAX_MESSAGE_CHARS = 200;

export function aiTitlesEnabled(): boolean {
  // RPC-mode runtimes cannot be spawned with --no-session (the flag only
  // exists on the web branch), so a title runtime would persist a ghost
  // session JSONL in the workspace. The feature needs Pi Orbit, disable it
  // under PI_SCIENCE_PI_MODE=rpc rather than polluting session storage.
  if (process.env.PI_SCIENCE_PI_MODE === "rpc") return false;
  return process.env.PI_SCIENCE_AI_TITLES !== "0";
}

/** Extract plain text from a message content array. */
function messageText(record: { role: string; content: Array<Record<string, unknown>> }): string {
  const text = record.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join(" ")
    .trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

async function excerpt(cwd: string, sessionId: string): Promise<string | null> {
  // messagesPage reads the newest messages without loading the whole JSONL.
  const page = await sessionRepository.messagesPage(cwd, sessionId, { limit: MAX_HISTORY_PAGE });
  const rows = page.messages ?? [];
  const taken: string[] = [];
  for (let index = rows.length - 1; index >= 0 && taken.length < MAX_HISTORY_MESSAGES; index -= 1) {
    const row = rows[index];
    if (!row || (row.role !== "user" && row.role !== "assistant")) continue;
    const text = messageText(row);
    if (!text) continue;
    taken.unshift(`${row.role}: ${text}`);
  }
  return taken.length > 0 ? taken.join("\n") : null;
}

async function buildPrompt(cwd: string, sessionId: string): Promise<string | null> {
  const history = await excerpt(cwd, sessionId);
  if (!history) return null;
  return [
    AI_TITLE_PROMPT_INSTRUCTION,
    "",
    "Conversation:",
    history,
  ].join("\n");
}

/** Strip surrounding quotes/brackets, collapse whitespace, drop line breaks. */
export function cleanTitle(raw: string): string | null {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  text = text.replace(/^[「『"'`]+|[」』"'`]+$/g, "").trim();
  text = text.replace(/^Title\s*[:：]\s*/i, "").trim();
  text = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_TITLE_LENGTH) return null;
  return text;
}

/** Extract the reply text from a get_last_assistant_text result (tolerant of
 *  `{ data: { text } }`, `{ data: "<text>" }` and `{ data: null }` shapes). */
function replyText(result: PiResult): string {
  if (!result.success) return "";
  const data = result.data as Record<string, unknown> | string | null | undefined;
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && typeof data.text === "string") return data.text;
  return "";
}

export class AiTitleService {
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly runtimeFactory: { start(cwd: string): Promise<TitleRuntime> },
    private readonly enabled: boolean = aiTitlesEnabled(),
    private readonly pollIntervalMs: number = POLL_INTERVAL_MS,
    private readonly timeoutMs: number = PROMPT_TIMEOUT_MS,
  ) {}

  /** Generate a title for the session, or null when disabled/empty/errors. */
  generateTitle(cwd: string, sessionId: string): Promise<string | null> {
    const key = `${cwd}\u0000${sessionId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const started = this.generateTitleUnlocked(cwd, sessionId).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  private async generateTitleUnlocked(cwd: string, sessionId: string): Promise<string | null> {
    if (!this.enabled) return null;
    const prompt = await buildPrompt(cwd, sessionId);
    if (!prompt) return null;
    let runtime: TitleRuntime | null = null;
    try {
      runtime = await this.runtimeFactory.start(cwd);
      const accepted = await runtime.sendCommand("prompt", { message: prompt });
      if (!accepted.success) return null;
      const deadline = Date.now() + this.timeoutMs;
      for (;;) {
        if (Date.now() >= deadline) return null;
        const reply = await runtime.sendCommand("get_last_assistant_text");
        if (!reply.success) return null;
        const raw = replyText(reply);
        if (raw) {
          // A non-empty reply that fails cleaning (over-long, or empty after
          // stripping decoration) can never become a title — bail out instead
          // of polling the remaining budget for a reply that already exists.
          const cleaned = cleanTitle(raw);
          if (cleaned) return cleaned;
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    } catch {
      return null;
    } finally {
      if (runtime) {
        try {
          await runtime.dispose();
        } catch {
          // Best-effort cleanup; a failed dispose must not surface errors.
        }
      }
    }
  }
}
