import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { withFileWriteLock, writeJsonAtomic } from "../persistence.js";
import { sessionRepository, type SessionMessageRecord, type SessionRepository } from "../session-repository.js";
import { readProjectState, statePath, timestamp, type Proposal } from "./project-state.js";
import type { ConversationExcerpt, ExcerptMessage, ReviewProposal, ReviewSubagentRunner } from "./types.js";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_EXCERPT_CHARS = 30_000;
const MAX_PROPOSALS = 5;

export class ProjectReviewBusyError extends Error {
  constructor() { super("A project review is already running for this workspace"); this.name = "ProjectReviewBusyError"; }
}

export interface ProjectReviewOptions { sessionId?: string | null; forceFullSession?: boolean; trigger?: "manual" | "auto" }
/** Response contract consumed verbatim by the frontend ✨ Review button. */
export interface ProjectReviewSummary { run_id: string; created: number; skipped: number; proposal_ids: string[]; message: string }

export class ProjectReviewService {
  private readonly running = new Map<string, Promise<ProjectReviewSummary>>();

  constructor(private readonly runner: ReviewSubagentRunner, private readonly repository: Pick<SessionRepository, "messages"> = sessionRepository) {}

  isRunning(cwd: string): boolean { return this.running.has(resolve(cwd)); }

  /** Single-flight per workspace: a concurrent call throws ProjectReviewBusyError. */
  async run(cwd: string, options: ProjectReviewOptions = {}): Promise<ProjectReviewSummary> {
    const key = resolve(cwd);
    if (this.running.has(key)) throw new ProjectReviewBusyError();
    const pending = this.execute(cwd, options).finally(() => { this.running.delete(key); });
    this.running.set(key, pending);
    return pending;
  }

  async shutdown(): Promise<void> { await this.runner.shutdown(); }

  private async execute(cwd: string, options: ProjectReviewOptions): Promise<ProjectReviewSummary> {
    const runId = `review-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const nothing = (message: string): ProjectReviewSummary => ({ run_id: runId, created: 0, skipped: 0, proposal_ids: [], message });
    const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
    if (options.trigger === "auto" && !(await readProjectState(cwd)).policy.auto_review) return nothing("Automatic project review is disabled for this workspace");
    if (!sessionId) return nothing("Open a conversation before running a project review");
    const excerpt = buildExcerpt(sessionId, await this.repository.messages(cwd, sessionId), options.forceFullSession === true);
    if (!excerpt.messages.length) return nothing("There is no conversation history to review yet");
    const result = await this.runner.run({ run_id: runId, cwd, session_id: sessionId, excerpt });
    const proposed = result.output.proposals.slice(0, MAX_PROPOSALS);
    if (!proposed.length) return nothing("No durable project knowledge was found in this conversation");
    return await withFileWriteLock(statePath(cwd), async () => {
      const current = await readProjectState(cwd);
      const known = new Set([...current.proposals.filter((item) => item.status === "pending"), ...current.items.filter((item) => item.status === "active")].map((item) => item.title.trim().toLowerCase()));
      const created: Proposal[] = [];
      let skipped = 0;
      for (const item of proposed) {
        const key = item.title.trim().toLowerCase();
        if (known.has(key)) { skipped += 1; continue; }
        known.add(key);
        created.push(toProposal(item, sessionId));
      }
      if (created.length) { current.proposals.push(...created); await writeJsonAtomic(statePath(cwd), current); }
      return { run_id: runId, created: created.length, skipped, proposal_ids: created.map((item) => item.id), message: reviewMessage(created.length, skipped) };
    });
  }
}

function reviewMessage(created: number, skipped: number): string {
  if (created > 0) return `${created} update proposal${created === 1 ? "" : "s"} added`;
  if (skipped > 0) return `${skipped} similar proposal${skipped === 1 ? " is" : "s are"} already pending review`;
  return "No durable project knowledge was found in this conversation";
}

function toProposal(item: ReviewProposal, sessionId: string): Proposal {
  const at = timestamp();
  return {
    id: `proposal-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    proposal_type: "knowledge",
    knowledge_type: item.knowledge_type,
    type: item.knowledge_type,
    title: item.title,
    summary: item.summary,
    reason: item.reason,
    confidence: item.confidence,
    importance: item.importance,
    status: "pending",
    source: { session_id: sessionId, message_ids: item.message_ids, files: item.related_files, run_ids: [], citations: [] },
    source_message_ids: item.message_ids,
    related_files: item.related_files,
    conflicts_with: [],
    supersedes: [],
    operations: [],
    decision_reason: null,
    applied_history_id: null,
    created_at: at,
    updated_at: at,
  };
}

function buildExcerpt(sessionId: string, messages: SessionMessageRecord[], full: boolean): ConversationExcerpt {
  const rows = messages
    .filter((message) => ["user", "assistant"].includes(message.role))
    .map((message, index): ExcerptMessage => ({ id: message.id || `message-${index}`, role: message.role, text: flatten(message.content).slice(0, MAX_MESSAGE_CHARS) }))
    .filter((message) => message.text.length > 0);
  const windowed = full ? rows : rows.slice(-MAX_MESSAGES);
  const kept: ExcerptMessage[] = [];
  let total = 0;
  for (let index = windowed.length - 1; index >= 0; index -= 1) {
    const row = windowed[index]!;
    if (kept.length && total + row.text.length > MAX_EXCERPT_CHARS) break;
    total += row.text.length;
    kept.unshift(row);
  }
  return { session_id: sessionId, messages: kept, truncated: kept.length < rows.length };
}

function flatten(content: Array<Record<string, unknown>>): string {
  return content
    .map((block) => (typeof block.text === "string" ? block.text : typeof block.content === "string" ? block.content : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}
