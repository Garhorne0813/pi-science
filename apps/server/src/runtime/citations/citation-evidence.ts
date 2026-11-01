/**
 * The evidence a model chose while it wrote a sentence, recorded at the moment
 * it wrote it.
 *
 * Reading a finished answer and searching the paper afterwards can only guess
 * which paragraph the writer meant. This module stores the other thing: the
 * model was shown numbered passages from one snapshot, and it named the ones it
 * used. The record is "these passages of this snapshot were handed to this
 * session and the model selected them here". It is not proof of reasoning and
 * not a judgement that the passage supports the sentence.
 *
 * Two tables live in one append-only file. A delivery says a session was shown
 * some passages of a snapshot; a selection names the passages the model used
 * for one claim. A selection is accepted only when a delivery for the same
 * session covers every passage it names, so a passage the model was never shown
 * cannot become generation-time evidence.
 */
import { createHash } from "node:crypto";
import { appendJsonLine, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { fullTextSnapshot, passageIdOf, readFullTextSnapshot, readFullTextVersion, refFromKey, snapshotIdOf, type FullTextDeps, type FullTextPassage, type FullTextSnapshot, type FullTextState } from "./citation-fulltext.js";

/** `generation`: the model selected these passages while writing. `located`:
 *  they were found by reading the finished sentence afterwards. The two are
 *  never shown as each other. */
export type EvidenceOrigin = "generation" | "located";

export type PositionState = FullTextState | "matched" | "no_match" | "unfetched" | "stale";

export interface CitationExcerpt {
  /** Verbatim, copied out of the snapshot passage. */
  text: string;
  /** Up to ~200 chars of the preceding passage, verbatim. */
  before: string;
  /** Up to ~200 chars of the following passage, verbatim. */
  after: string;
  section_title: string | null;
  section_id: string | null;
  page: number | null;
  /** Retrieval score for a passage found after the fact; null when the model
   *  chose it, because a choice is not a score. Never a support probability. */
  score: number | null;
  /** Identity inside the snapshot, so a reader opens exactly this paragraph. */
  passage_id: string;
}

export interface PositionResult {
  key: string;
  claim_sha256: string;
  state: PositionState;
  note: string | null;
  snapshot_sha256: string | null;
  snapshot_id: string | null;
  origin: EvidenceOrigin;
  excerpts: CitationExcerpt[];
}

export type SelectionRejectReason = "bad_source" | "empty_claim" | "unknown_snapshot" | "unknown_passage" | "not_delivered";

export interface SelectionRequest {
  /** `doi:<id>` or `arxiv:<id>`, the key the answer's marker carries. */
  source: string;
  /** The sentence the model wrote this citation into, copied exactly. */
  claim: string;
  snapshot_id: string;
  passage_ids: string[];
}

export interface SelectionOutcome {
  source: string;
  accepted: boolean;
  reason: SelectionRejectReason | null;
  note: string | null;
}

export interface DeliveredPassage { passage_id: string; section_title: string | null; section_id: string | null; page: number | null; text: string }

export interface SourceReadResult {
  source: string;
  state: FullTextState | "bad_source" | "unfetched";
  note: string | null;
  snapshot_id: string | null;
  provider: string | null;
  url: string | null;
  retrieved_at: string | null;
  license: string | null;
  section: string | null;
  total: number;
  skip: number;
  passages: DeliveredPassage[];
}

interface DeliveryRow {
  row: "delivery";
  session_id: string;
  source: string;
  snapshot_id: string;
  passage_ids: string[];
  at: string;
}

interface SelectionRow {
  row: "selection";
  session_id: string;
  source: string;
  claim: string;
  claim_sha256: string;
  snapshot_id: string;
  passage_ids: string[];
  at: string;
}

type StoredRow = DeliveryRow | SelectionRow;

export interface GenerationRecord { snapshot_id: string; passage_ids: string[]; claim: string; recorded_at: string }

export type GenerationLookup = { state: "recorded"; record: GenerationRecord; snapshot: FullTextSnapshot } | { state: "stale"; record: GenerationRecord } | { state: "absent" };

/** The neighbouring paragraphs are the context a reader needs to judge an
 *  excerpt. Both are copied out of the same snapshot, so the only text a card
 *  ever shows is text the paper published. */
const NEIGHBOR_CHARS = 200;
const MAX_CLAIM_CHARS = 4_000;
const MAX_SELECTIONS_PER_CALL = 30;
/** A read hands the model one page of passages at a time. A whole paper in one
 *  answer would crowd out the writing it is supposed to inform. */
const MAX_PASSAGES_PER_READ = 12;
const MAX_READ_CHARS = 12_000;
const MAX_ROWS = 4_000;

function evidenceFile(cwd: string): string {
  return workspaceFile(cwd, "citations-evidence.jsonl");
}

function claimHash(claim: string): string {
  return createHash("sha256").update(claim).digest("hex");
}

async function readRows(cwd: string): Promise<StoredRow[]> {
  const rows = await readJsonLines<Record<string, unknown>>(evidenceFile(cwd));
  const result: StoredRow[] = [];
  for (const row of rows) {
    if (typeof row.session_id !== "string" || typeof row.source !== "string" || typeof row.snapshot_id !== "string" || !Array.isArray(row.passage_ids)) continue;
    const passage_ids = row.passage_ids.filter((id): id is string => typeof id === "string");
    if (row.row === "delivery") {
      result.push({ row: "delivery", session_id: row.session_id, source: row.source, snapshot_id: row.snapshot_id, passage_ids, at: String(row.at ?? "") });
      continue;
    }
    if (row.row === "selection" && typeof row.claim === "string" && typeof row.claim_sha256 === "string") {
      result.push({ row: "selection", session_id: row.session_id, source: row.source, claim: row.claim, claim_sha256: row.claim_sha256, snapshot_id: row.snapshot_id, passage_ids, at: String(row.at ?? "") });
    }
  }
  return result.slice(-MAX_ROWS);
}

/** The snapshot a recorded citation names. The current read answers first
 *  because it is what a reader usually opens; the version file answers only
 *  when the paper has been fetched again since, and it answers only for the
 *  exact bytes that were recorded. */
async function recordedSnapshot(cwd: string, source: string, snapshotId: string): Promise<FullTextSnapshot | null> {
  const ref = refFromKey(source);
  if (!ref) return null;
  const current = await readFullTextSnapshot(cwd, ref.kind, ref.id);
  if (current && snapshotIdOf(current) === snapshotId) return current;
  return await readFullTextVersion(cwd, ref.kind, ref.id, snapshotId);
}

function passageOf(snapshot: FullTextSnapshot, passageId: string): FullTextPassage | null {
  const match = /^p(\d{1,5})$/.exec(passageId);
  if (!match) return null;
  const index = Number(match[1]);
  return snapshot.passages.find((passage) => passage.index === index) ?? null;
}

function excerptOf(snapshot: FullTextSnapshot, passage: FullTextPassage): CitationExcerpt {
  const at = snapshot.passages.indexOf(passage);
  const before = at > 0 ? snapshot.passages[at - 1]?.text.slice(-NEIGHBOR_CHARS) ?? "" : "";
  const after = at >= 0 && at + 1 < snapshot.passages.length ? snapshot.passages[at + 1]?.text.slice(0, NEIGHBOR_CHARS) ?? "" : "";
  return { text: passage.text, before, after, section_title: passage.section_title, section_id: passage.section_id, page: passage.page, score: null, passage_id: passageIdOf(passage.index) };
}

function excerptWithin(text: string, passage: FullTextPassage): CitationExcerpt | null {
  return text.includes(passage.text) ? { text: passage.text, before: "", after: "", section_title: passage.section_title, section_id: passage.section_id, page: passage.page, score: null, passage_id: passageIdOf(passage.index) } : null;
}

/** Passages the model named, as excerpts. Anything that no longer resolves is
 *  dropped rather than replaced: a card with no excerpt says so, which is
 *  honest, and a substituted paragraph is not. */
export function generationExcerpts(snapshot: FullTextSnapshot, passageIds: string[]): CitationExcerpt[] {
  const excerpts: CitationExcerpt[] = [];
  for (const passageId of passageIds) {
    const passage = passageOf(snapshot, passageId);
    if (!passage) continue;
    const excerpt = excerptOf(snapshot, passage);
    if (excerptWithin(excerpt.text, passage)) excerpts.push(excerpt);
  }
  return excerpts;
}

function sectionMatches(passage: FullTextPassage, section: string): boolean {
  const wanted = section.trim().toLowerCase();
  if (!wanted) return true;
  const title = (passage.section_title ?? "").toLowerCase();
  return title === wanted || title.includes(wanted) || (passage.section_id ?? "").toLowerCase() === wanted;
}

export const citationEvidenceService = {
  /** Hand a session the passages of one source, numbered. This is the only
   *  place a passage becomes something the model could have chosen, so the
   *  delivery row written here is what a later selection is checked against.
   *  Only a source that is genuinely open is read; the fetch path is the same
   *  one the source card uses, with its egress record and its rate limit. */
  async readSource(cwd: string, input: { session_id: string; source: string; section?: string; skip?: number; limit?: number }, deps: FullTextDeps = {}): Promise<SourceReadResult> {
    const ref = refFromKey(input.source);
    const head = { snapshot_id: null, provider: null, url: null, retrieved_at: null, license: null, section: input.section?.trim() || null, total: 0, skip: 0, passages: [] as DeliveredPassage[] };
    if (!ref) return { source: input.source, state: "bad_source", note: "the source must be doi:<id> or arxiv:<id>", ...head };
    const snapshot = await fullTextSnapshot(cwd, ref, {}, deps);
    const snapshotId = snapshot ? snapshotIdOf(snapshot) : null;
    if (!snapshot) return { source: input.source, state: "unfetched", note: "full text not fetched yet", ...head };
    const read = { ...head, snapshot_id: snapshotId, provider: snapshot.provider, url: snapshot.url, retrieved_at: snapshot.retrieved_at, license: snapshot.license };
    if (snapshot.state !== "available") return { source: input.source, state: snapshot.state, note: snapshot.note, ...read };
    const matching = snapshot.passages.filter((passage) => sectionMatches(passage, input.section ?? ""));
    const skip = Math.max(0, Math.min(Math.trunc(input.skip ?? 0), matching.length));
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_PASSAGES_PER_READ), MAX_PASSAGES_PER_READ));
    const passages: DeliveredPassage[] = [];
    let budget = MAX_READ_CHARS;
    for (const passage of matching.slice(skip, skip + limit)) {
      if (passage.text.length > budget) break;
      budget -= passage.text.length;
      passages.push({ passage_id: passageIdOf(passage.index), section_title: passage.section_title, section_id: passage.section_id, page: passage.page, text: passage.text });
    }
    if (passages.length && snapshotId) {
      await appendJsonLine(evidenceFile(cwd), { row: "delivery", session_id: input.session_id, source: input.source, snapshot_id: snapshotId, passage_ids: passages.map((passage) => passage.passage_id), at: new Date().toISOString() } satisfies DeliveryRow);
    }
    return { source: input.source, state: snapshot.state, note: passages.length ? null : "no passage in this slice of the source", ...read, total: matching.length, skip, passages };
  },

  /** Record what the model says it used. Every entry is checked against the
   *  delivery table and against the snapshot's own passage list; an entry that
   *  fails is reported with its reason instead of being stored. */
  async record(cwd: string, input: { session_id: string; selections: SelectionRequest[] }): Promise<{ accepted: number; rejected: number; results: SelectionOutcome[] }> {
    if (!input.session_id) throw new Error("a session id is required to record evidence");
    if (!Array.isArray(input.selections) || !input.selections.length) throw new Error("selections must be a non-empty array");
    if (input.selections.length > MAX_SELECTIONS_PER_CALL) throw new Error(`at most ${MAX_SELECTIONS_PER_CALL} selections per call`);
    const rows = await readRows(cwd);
    const results: SelectionOutcome[] = [];
    for (const selection of input.selections) {
      const source = String(selection.source ?? "").trim();
      const claim = String(selection.claim ?? "").trim();
      const snapshotId = String(selection.snapshot_id ?? "").trim();
      const passageIds = Array.isArray(selection.passage_ids) ? selection.passage_ids.filter((id): id is string => typeof id === "string" && id.trim() !== "") : [];
      const reject = (reason: SelectionRejectReason, note: string): void => { results.push({ source, accepted: false, reason, note }); };
      if (!refFromKey(source)) { reject("bad_source", "the source must be doi:<id> or arxiv:<id>"); continue; }
      if (!claim) { reject("empty_claim", "the claim must be the sentence this citation sits in"); continue; }
      if (claim.length > MAX_CLAIM_CHARS) { reject("empty_claim", `the claim must be at most ${MAX_CLAIM_CHARS} characters`); continue; }
      if (!snapshotId || !passageIds.length) { reject("unknown_snapshot", "a snapshot id and at least one passage id are required"); continue; }
      const snapshot = await recordedSnapshot(cwd, source, snapshotId);
      if (!snapshot) { reject("unknown_snapshot", `no stored read of ${source} answers snapshot ${snapshotId}`); continue; }
      const missing = passageIds.filter((id) => !passageOf(snapshot, id));
      if (missing.length) { reject("unknown_passage", `the snapshot holds no passage ${missing.join(", ")}`); continue; }
      const delivered = rows.some((row) => row.row === "delivery" && row.session_id === input.session_id && row.source === source && row.snapshot_id === snapshotId && passageIds.every((id) => row.passage_ids.includes(id)));
      if (!delivered) { reject("not_delivered", "these passages were not handed to this session from this snapshot"); continue; }
      const row: SelectionRow = { row: "selection", session_id: input.session_id, source, claim, claim_sha256: claimHash(claim), snapshot_id: snapshotId, passage_ids: passageIds, at: new Date().toISOString() };
      await appendJsonLine(evidenceFile(cwd), row);
      rows.push(row);
      results.push({ source, accepted: true, reason: null, note: null });
    }
    return { accepted: results.filter((result) => result.accepted).length, rejected: results.filter((result) => !result.accepted).length, results };
  },

  /** The generation-time record for one citation position, if this session
   *  recorded one. The claim is matched exactly, not by similarity: a near
   *  sentence is a different citation position. */
  async lookup(cwd: string, input: { session_id: string; key: string; claim: string }): Promise<GenerationLookup> {
    if (!input.session_id) return { state: "absent" };
    const rows = await readRows(cwd);
    const wanted = claimHash(input.claim.trim());
    const row = rows.findLast((entry) => entry.row === "selection" && entry.session_id === input.session_id && entry.source === input.key && entry.claim_sha256 === wanted);
    if (!row || row.row !== "selection") return { state: "absent" };
    const record: GenerationRecord = { snapshot_id: row.snapshot_id, passage_ids: row.passage_ids, claim: row.claim, recorded_at: row.at };
    const snapshot = await recordedSnapshot(cwd, row.source, row.snapshot_id);
    return snapshot ? { state: "recorded", record, snapshot } : { state: "stale", record };
  },
};
