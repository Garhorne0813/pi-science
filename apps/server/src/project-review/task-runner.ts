import type { TaskRuntime as AgentRuntime } from "../runtime/agent/runner-transport.js";
import type { WorkspaceEnvironmentService } from "../runtime/workspace/workspace-environment.js";
import { knowledgeTypes, parseReviewResult, type ConversationExcerpt, type ReviewRunRequest, type ReviewRunResult, type ReviewSubagentRunner } from "./types.js";

const RUN_TIMEOUT_MS = 5 * 60_000;
const REPAIR_ATTEMPTS = 1;

/** Backend-independent review policy, schema repair and bounded lifecycle. */
export abstract class ReviewTaskRunner implements ReviewSubagentRunner {
  private readonly active = new Map<AgentRuntime, string>();

  constructor(
    protected readonly environments: Pick<WorkspaceEnvironmentService, "environment">,
  ) {}

  async run(request: ReviewRunRequest): Promise<ReviewRunResult> {
    const managerKey = `review:${request.run_id}`;
    const process = await this.startProcess(request.cwd, managerKey, request.run_id);
    this.active.set(process, managerKey);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let promptIndex = 0;
    const promptAndWait = (message: string) => process.prompt({
      message, clientMessageId: `${managerKey}:${promptIndex++}`, deadline,
    });

    try {
      await process.initialize();
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
      this.active.delete(process);
      await this.stopProcess(managerKey).catch(() => undefined);
    }
  }

  protected abstract startProcess(cwd: string, key: string, owner: string): Promise<AgentRuntime>;
  protected abstract stopProcess(key: string): Promise<void>;

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((managerKey) => this.stopProcess(managerKey)));
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
