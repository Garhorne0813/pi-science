import { CredentialStore } from "../../model-resources/credential-store.js";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { AgentRuntimeManager } from "../agent/agent-runtime-manager.js";
import type { RuntimeResult } from "../agent/agent-runtime-types.js";
import { loadDefaultPiConfig } from "../agent/runtime-config.js";
import { sessionRepository } from "../node/session-repository.js";
import { WorkspaceEnvironmentService } from "../workspace/workspace-environment.js";
import { readJson, workspaceFile } from "../../storage/persistence.js";
import { hiddenSessionsRoot, openHiddenTask } from "../agent/hidden-agent-task.js";
import { AgentSessionRegistry } from "../agent/agent-session-registry.js";
import { AI_TITLE_PROMPT_INSTRUCTION } from "./title-prompt.js";

/** Minimum runtime surface the title service needs; tests provide a fake. */
export interface TitleRuntime {
  sendCommand(type: string, params?: Record<string, unknown>): Promise<RuntimeResult>;
  dispose(): Promise<void>;
}

/** A disposable core worker with no tools or skills. */
export class CoreTitleRuntimeFactory {
  private readonly environments: WorkspaceEnvironmentService;
  private readonly pending = new Set<Promise<TitleRuntime>>();
  private readonly disposers = new Set<() => Promise<void>>();
  private closing = false;

  constructor(
    private readonly manager: AgentRuntimeManager = new AgentRuntimeManager(),
    environments?: WorkspaceEnvironmentService,
  ) {
    // Injectable for tests: the real service provisions a python venv in the
    // workspace (spawn python -m venv), which is far too slow for CI units
    // that only verify dispose routing.
    this.environments = environments ?? new WorkspaceEnvironmentService();
  }

  async shutdownAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    await this.manager.shutdownAll();
    await Promise.allSettled([...this.disposers].map((dispose) => dispose()));
  }

  async start(cwd: string): Promise<TitleRuntime> {
    if (this.closing) throw new Error("Title runtime factory is closing");
    const pending = this.startOnce(cwd);
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }

  private async startOnce(cwd: string): Promise<TitleRuntime> {
    const config = loadDefaultPiConfig();
    const environment = await this.environments.environment(cwd);
    if (!config.model?.includes("/")) throw new Error("Title generation requires a configured model");
    const separator = config.model.indexOf("/");
    const credentials = await new CredentialStore().listMetadata();
    const credentialEnvNames = credentials.flatMap((item) => item.backend === "environment" && item.environment_variable ? [item.environment_variable] : []);
    const options = { cwd, sessionsRoot: hiddenSessionsRoot(cwd),
      model: { provider: config.model.slice(0, separator), modelId: config.model.slice(separator + 1) },
      thinking: "off" as const, settings: config, allowedTools: [], skillPaths: [], skillPolicy: { mode: "none" as const }, credentialEnvNames,
      env: environment as Record<string, string> };
    const key = randomUUID();
    const link = workspaceFile(cwd, `agent-task-links/${createHash("sha256").update(key).digest("hex")}.json`);
    let disposing: Promise<void> | undefined;
    const dispose = (): Promise<void> => disposing ??= (async () => {
      try { await this.manager.stop(key); }
      finally {
        const saved = await readJson<{ sessionId?: string }>(link, {});
        if (saved.sessionId) {
          const registry = new AgentSessionRegistry();
          const registered = await registry.get(cwd, saved.sessionId);
          if (registered?.target) {
            await registry.markDeleted(cwd, saved.sessionId, registered.target);
            await rm(registered.target, { force: true });
          }
        }
        await rm(link, { force: true });
        this.disposers.delete(dispose);
      }
    })();
    this.disposers.add(dispose);
    try {
      const process = await openHiddenTask(this.manager, key, options, `title:${key}`);
      const activated = await process.sendCommand("activate");
      if (!activated.success) throw new Error(activated.error ?? "Title worker activation failed");
      return { sendCommand: (type, params = {}) => process.sendCommand(type, params), dispose };
    } catch (error) { await dispose(); throw error; }
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
function replyText(result: RuntimeResult): string {
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
