/**
 * Server-side scheduling for automatic citation verification, modelled on the
 * automatic project review: a settled turn is the only trigger, the stored
 * setting decides whether any provider is contacted, and a per-turn answer
 * hash makes a replayed or recovered settle event idempotent.
 *
 * The result is written to the same evidence snapshot the manual path uses, so
 * the chips read authoritative state after a refresh and no second
 * subscription is needed.
 */
import { createHash } from "node:crypto";
import { configPath, readJson, withFileWriteLock, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { sessionRepository, type SessionMessageRecord, type SessionRepository } from "../node/session-repository.js";
import { citationVerifyService, extractCitations, type VerifyCitationsResult } from "./citation-verify-service.js";

/** Settings key shared with the HTTP route and the settings store. */
export const CITATION_AUTO_VERIFY_KEY = "citation_auto_verify";
const CLAIMS_FILE = "citation-auto-verify.json";
const MAX_CLAIMS = 500;

/** Off unless the user turns it on. Automatic verification contacts public
 *  scholarly APIs on every completed turn, so it must be opted into. */
export async function citationAutoVerifyEnabled(): Promise<boolean> {
  const config = await readJson<Record<string, unknown>>(configPath("config.json"), {});
  return config[CITATION_AUTO_VERIFY_KEY] === true;
}

/** The answer a settled turn produced, or null when the turn did not end as a
 *  normal completion with a final assistant message. Failed, aborted and
 *  declined turns and compaction-only turns are not answers. */
export function finalAnswerForTurn(messages: SessionMessageRecord[], turnId: string): string | null {
  const turn = messages.filter((message) => message.turnId === turnId);
  // A settle event can arrive before this turn's messages are readable, and a
  // recovered operation may never have stored any. The session's previous final
  // answer belongs to another turn: verifying it would break the "current turn
  // only" rule and file that answer under this turn's claim.
  if (!turn.length) return null;
  if (turn.some((message) => message.turnStatus !== undefined && message.turnStatus !== "completed")) return null;
  const finals = turn.filter((message) => message.role === "assistant" && message.presentationRole === "final");
  const chosen = finals.at(-1);
  if (!chosen) return null;
  const text = chosen.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("").trim();
  return text || null;
}

type Claims = Record<string, { answerHash: string; verified_at: string }>;

function claimsPath(cwd: string): string {
  return workspaceFile(cwd, CLAIMS_FILE);
}

/** Reserve one logical verification for this turn. False means this exact
 *  answer was already checked, so a replayed settle does no provider work. */
async function claimTurn(cwd: string, sessionId: string, turnId: string, answerHash: string): Promise<boolean> {
  const file = claimsPath(cwd);
  return withFileWriteLock(file, async () => {
    const claims = await readJson<Claims>(file, {});
    const key = `${sessionId}:${turnId}`;
    if (claims[key]?.answerHash === answerHash) return false;
    claims[key] = { answerHash, verified_at: new Date().toISOString() };
    const keys = Object.keys(claims);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_CLAIMS))) delete claims[stale];
    await writeJsonAtomic(file, claims);
    return true;
  });
}

async function releaseTurn(cwd: string, sessionId: string, turnId: string, answerHash: string): Promise<void> {
  const file = claimsPath(cwd);
  await withFileWriteLock(file, async () => {
    const claims = await readJson<Claims>(file, {});
    const key = `${sessionId}:${turnId}`;
    // A regenerate replaces the claim while an older run may still be in
    // flight. Only the run holding this hash may release it, or it would drop
    // the newer claim and verify the regenerated answer a second time.
    if (claims[key]?.answerHash !== answerHash) return;
    delete claims[key];
    await writeJsonAtomic(file, claims);
  });
}

export interface CitationAutoVerifySummary { ran: boolean; reason: string; citations: number }

export class CitationAutoVerifyService {
  /** One chain per workspace and session, so a turn that settles while an
   *  earlier one is still querying is queued instead of dropped. */
  private readonly queue = new Map<string, Promise<unknown>>();
  constructor(
    private readonly repository: Pick<SessionRepository, "messages"> = sessionRepository,
    private readonly verify: typeof citationVerifyService.verify = citationVerifyService.verify,
  ) {}

  schedule(cwd: string, sessionId: string, turnId: string, log: (level: "warn", message: string) => void = () => {}): void {
    if (!cwd || !sessionId || !turnId) return;
    const key = `${cwd}\0${sessionId}`;
    const next = (this.queue.get(key) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.run(cwd, sessionId, turnId))
      .catch((error: unknown) => log("warn", `automatic citation verification failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (this.queue.get(key) === next) this.queue.delete(key); });
    this.queue.set(key, next);
  }

  async run(cwd: string, sessionId: string, turnId: string): Promise<CitationAutoVerifySummary> {
    if (!(await citationAutoVerifyEnabled())) return { ran: false, reason: "Automatic citation verification is off", citations: 0 };
    const messages = await this.repository.messages(cwd, sessionId);
    const answer = finalAnswerForTurn(messages, turnId);
    if (!answer) return { ran: false, reason: "This turn has no completed final answer", citations: 0 };
    const citations = extractCitations(answer);
    if (!citations.length) return { ran: false, reason: "No supported DOI or arXiv identifier in the answer", citations: 0 };
    const answerHash = createHash("sha256").update(answer).digest("hex");
    if (!(await claimTurn(cwd, sessionId, turnId, answerHash))) return { ran: false, reason: "This answer was already checked", citations: 0 };
    let result: VerifyCitationsResult;
    try {
      result = await this.verify(cwd, { text: answer });
    } catch (error) {
      // The claim was taken before the work started. Throwing past it would
      // mark this answer as checked forever, so hand the claim back and let the
      // caller log the failure.
      await releaseTurn(cwd, sessionId, turnId, answerHash);
      throw error;
    }
    // An answer whose every lookup failed is not checked; keep it retryable.
    if (result.citations.length > 0 && result.citations.every((citation) => citation.status === "error")) {
      await releaseTurn(cwd, sessionId, turnId, answerHash);
      return { ran: false, reason: "Every lookup failed", citations: 0 };
    }
    return { ran: true, reason: `Checked ${result.processed} of ${result.total} citations`, citations: result.processed };
  }
}
