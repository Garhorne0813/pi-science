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
import { citationVerifyService, extractCitations, type CitationRef, type VerifyCitationsResult } from "./citation-verify-service.js";

/** Settings key shared with the HTTP route and the settings store. */
export const CITATION_AUTO_VERIFY_KEY = "citation_auto_verify";
const CLAIMS_FILE = "citation-auto-verify.json";
const MAX_CLAIMS = 500;
/** Hard bound on the batches one turn may ask for. Ten rounds of
 *  MAX_CITATIONS_PER_CALL is 300 sources; a longer answer is reported as
 *  partly unchecked instead of holding the settle event open. */
export const MAX_VERIFY_ROUNDS = 10;

/** On unless the user turned it off. A missing key means no choice was stored
 *  yet, which reads as on; a stored boolean is the user's own answer and is
 *  honoured as stored, so an explicit false stays off. */
export async function citationAutoVerifyEnabled(): Promise<boolean> {
  const config = await readJson<Record<string, unknown>>(configPath("config.json"), {});
  const stored = config[CITATION_AUTO_VERIFY_KEY];
  return typeof stored === "boolean" ? stored : true;
}

/** The answer a settled turn produced, or null when the turn did not end as a
 *  normal completion carrying an answer. Failed, aborted and declined turns
 *  and turns that ended on a tool call are not answers.
 *
 *  A stored `presentationRole` is the runtime's own statement about which
 *  message is the answer, but sessions written before it existed carry none,
 *  so the last assistant message stands in for the answer. That fallback never
 *  looks further back than the last message: an earlier commentary message is
 *  never the answer, however final it reads. */
export function finalAnswerForTurn(messages: SessionMessageRecord[], turnId: string): string | null {
  const turn = messages.filter((message) => message.turnId === turnId);
  // A settle event can arrive before this turn's messages are readable, and a
  // recovered operation may never have stored any. The session's previous final
  // answer belongs to another turn: verifying it would break the "current turn
  // only" rule and file that answer under this turn's claim.
  if (!turn.length) return null;
  if (turn.some((message) => message.turnStatus !== undefined && message.turnStatus !== "completed")) return null;
  const assistants = turn.filter((message) => message.role === "assistant");
  const chosen = assistants.filter((message) => message.presentationRole === "final").at(-1) ?? (assistants.at(-1)?.presentationRole === "intermediate" ? undefined : assistants.at(-1));
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

const refKey = (ref: CitationRef): string => `${ref.kind}:${ref.id}`;

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
    // A turn can cite more sources than one call resolves, so the rest are
    // asked for by id until none are left. A source that already answered is
    // replayed from its snapshot, so a second round never queries it again.
    let checked = 0;
    const failed: CitationRef[] = [];
    let unchecked: CitationRef[] = [];
    let pending: CitationRef[] | undefined;
    try {
      for (let round = 1; ; round += 1) {
        const result: VerifyCitationsResult = pending ? await this.verify(cwd, { text: answer, ids: pending }) : await this.verify(cwd, { text: answer });
        for (const citation of result.citations) {
          if (citation.status === "error") failed.push({ kind: citation.kind, id: citation.id, requested_id: citation.requested_id, requested_version: citation.requested_version });
          else checked += 1;
        }
        if (!result.unprocessed.length) break;
        if (round >= MAX_VERIFY_ROUNDS) { unchecked = result.unprocessed; break; }
        pending = result.unprocessed;
      }
    } catch (error) {
      // The claim was taken before the work started. Throwing past it would
      // mark this answer as checked forever, so hand the claim back and let the
      // caller log the failure.
      await releaseTurn(cwd, sessionId, turnId, answerHash);
      throw error;
    }
    const coverage = checked === 0 ? "Every lookup failed" : `Checked ${checked} of ${citations.length} citations`;
    const notes = [coverage];
    if (failed.length) notes.push(`${failed.length} lookup${failed.length === 1 ? "" : "s"} failed and will be retried: ${failed.map(refKey).join(", ")}`);
    if (unchecked.length) notes.push(`${unchecked.length} left unchecked after ${MAX_VERIFY_ROUNDS} rounds`);
    const reason = notes.join("; ");
    // A lookup that failed is not a checked source, so the turn must stay
    // retryable. Releasing the claim re-asks for the whole answer, but the
    // snapshot of every source that answered replays without a provider call:
    // only the failed ones are queried again.
    if (failed.length) {
      await releaseTurn(cwd, sessionId, turnId, answerHash);
      return { ran: checked > 0, reason, citations: checked };
    }
    return { ran: true, reason, citations: checked };
  }
}
