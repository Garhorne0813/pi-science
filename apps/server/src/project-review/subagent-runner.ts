import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { metadataRoot } from "../persistence.js";
import { PiManager, piManager } from "../pi-manager.js";
import type { PiProcess, PiEvent } from "../pi-process.js";
import { buildPiProcessOptions, loadDefaultPiConfig } from "../pi-runtime-launch.js";
import type { WorkspaceEnvironmentService } from "../workspace-environment.js";
import { knowledgeTypes, parseReviewResult, type ConversationExcerpt, type ReviewRunRequest, type ReviewRunResult, type ReviewSubagentRunner } from "./types.js";

const RESPONSE_LIMIT_BYTES = 2_000_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const REPAIR_ATTEMPTS = 1;

/** Runs one bounded reviewer turn in a throwaway Pi Orbit runtime. Deliberately a
 *  sibling of the research-loop runner rather than a shared abstraction: the
 *  two have different lifecycles (one-shot vs. long-lived loop). */
export class PiReviewSubagentRunner implements ReviewSubagentRunner {
  private readonly active = new Map<PiProcess, string>();

  constructor(
    private readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
    private readonly manager: PiManager = piManager,
  ) {}

  async run(request: ReviewRunRequest): Promise<ReviewRunResult> {
    const sessionDir = join(metadataRoot(request.cwd), "review-sessions", request.run_id);
    await mkdir(sessionDir, { recursive: true });
    const options = buildPiProcessOptions(request.cwd, loadDefaultPiConfig(), undefined, await this.environments.environment(request.cwd));
    if (!options) throw new Error("Pi CLI is not configured");
    const index = options.args.indexOf("--session-dir");
    if (index >= 0) options.args[index + 1] = sessionDir;
    if (options.web) options.web.runtime.sessionDir = sessionDir;
    options.requestTimeoutMs = 30_000;

    const managerKey = `review:${request.run_id}`;
    const process = await this.manager.start(managerKey, options);
    this.active.set(process, managerKey);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let text = "";
    let settle: (() => void) | null = null;
    let rejectCycle: ((error: Error) => void) | null = null;
    process.on("event", (event: PiEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (["text_delta", "text"].includes(String(update?.type ?? ""))) {
          text += String(update?.delta ?? update?.text ?? update?.content ?? "");
          if (Buffer.byteLength(text, "utf8") > RESPONSE_LIMIT_BYTES) rejectCycle?.(new Error("project reviewer response exceeds 2 MB"));
        }
      }
      if (event.type === "agent_settled") settle?.();
    });
    process.once("exit", () => rejectCycle?.(new Error("project reviewer exited before completing")));

    const promptAndWait = async (message: string): Promise<string> => {
      text = "";
      const completed = new Promise<void>((resolvePrompt, rejectPrompt) => {
        const timer = setTimeout(() => rejectPrompt(new Error("project reviewer timed out")), Math.max(1, deadline - Date.now()));
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          settle = null;
          rejectCycle = null;
          error ? rejectPrompt(error) : resolvePrompt();
        };
        settle = () => finish();
        rejectCycle = (error) => finish(error);
      });
      const acknowledged = await process.sendCommand("prompt", { message });
      if (!acknowledged.success) rejectCycle?.(new Error(String(acknowledged.error ?? "project reviewer rejected prompt")));
      await completed;
      return text;
    };

    try {
      const state = await process.sendCommand("get_state");
      if (!state.success) throw new Error(String(state.error ?? "unable to initialize the project reviewer"));
      let response = await promptAndWait(reviewPrompt(request.excerpt));
      let parseError: unknown;
      for (let attempt = 0; attempt <= REPAIR_ATTEMPTS; attempt += 1) {
        try { return { run_id: request.run_id, output: parseReviewResult(response) }; }
        catch (error) {
          parseError = error;
          if (attempt === REPAIR_ATTEMPTS) break;
          response = await promptAndWait(`Your previous response did not match the required JSON schema. Return ONLY the corrected JSON array, with no markdown and no explanation. Validation error: ${String(error).slice(0, 2000)}`);
        }
      }
      throw parseError instanceof Error ? parseError : new Error("project reviewer returned invalid JSON");
    } finally {
      process.removeAllListeners("event");
      process.removeAllListeners("exit");
      this.active.delete(process);
      await this.manager.stop(managerKey).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((managerKey) => this.manager.stop(managerKey)));
    this.active.clear();
  }
}

function reviewPrompt(excerpt: ConversationExcerpt): string {
  const transcript = excerpt.messages.map((message) => `<message id="${message.id}" role="${message.role}">\n${message.text}\n</message>`).join("\n");
  return [
    "You are the project reviewer for a scientific workspace. Read the conversation excerpt below and propose the durable project knowledge worth keeping after the conversation is forgotten.",
    "Rules: propose between 0 and 5 items; propose nothing when the conversation contains only chit-chat, tool noise, or transient debugging; never restate the whole conversation; each item must stand on its own months later.",
    `Each item is an object with: knowledge_type (one of ${knowledgeTypes.join(", ")}), title (<= 120 characters), summary (2-4 sentences), reason (why it is durable), confidence (low|medium|high), importance (normal|important|critical), related_files (workspace-relative paths mentioned in the excerpt), message_ids (the id attributes of the messages this item came from).`,
    "Do not edit files, do not run code, and do not use tools. Return ONLY a JSON array of those objects — no markdown fences, no prose. Return [] when nothing is worth keeping.",
    excerpt.truncated ? "The excerpt below is the tail of a longer conversation." : "",
    `<conversation session_id="${excerpt.session_id}">\n${transcript}\n</conversation>`,
  ].filter(Boolean).join("\n\n");
}
