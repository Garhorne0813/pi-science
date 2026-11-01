/**
 * Locate the passage behind one in-text citation position.
 *
 * A citation number says "this sentence rests on source X". The reader wants
 * the actual sentence in X, with its section and its neighbours, the way a
 * source reader shows a highlighted passage. This module ranks the snapshot
 * passages a source already holds against the claim and returns verbatim
 * copies, so the quote a reader sees is text from the paper and not a
 * paraphrase of it.
 *
 * The score is a retrieval score. It says "this passage shares the claim's
 * terms", never "this paper supports the claim": support needs the reader's
 * judgement, a summary sentence or a model reading the claim, and a number
 * that looks like a probability would hide that difference.
 */
import { createHash } from "node:crypto";
import { appendJsonLine, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { fullTextSnapshot, passageIdOf, refFromKey, snapshotIdOf, type FullTextDeps, type FullTextPassage, type FullTextSnapshot } from "./citation-fulltext.js";
import { citationEvidenceService, generationExcerpts, type CitationExcerpt, type PositionResult } from "./citation-evidence.js";

export type { CitationExcerpt, PositionResult } from "./citation-evidence.js";

export interface PassageRequest { key: string; claim: string }

const MAX_EXCERPTS = 3;
const NEIGHBOR_CHARS = 200;
/** BM25 scores are unbounded, so a cut has to be both absolute (a passage of
 *  unrelated text scores near zero) and relative to the best passage (a claim
 *  that matches one paragraph well must not drag in three weak neighbours). */
const MIN_SCORE = 1.5;
const RELATIVE_CUTOFF = 0.35;
const MAX_CACHE_ROWS = 500;

const WORD = /[\p{L}\p{N}]+/gu;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
/** Closed-class words carry no claim. In a short paper the idf of a once-seen
 *  "of" is as large as a content word's, so an unrelated sentence would match
 *  on grammar alone; dropping them keeps a match about what the paper says. */
const STOPWORDS = new Set(["a", "an", "as", "at", "be", "by", "do", "does", "did", "if", "in", "is", "it", "of", "on", "or", "out", "per", "so", "to", "up", "us", "we", "the", "and", "for", "with", "from", "that", "this", "these", "those", "are", "was", "were", "been", "being", "has", "have", "had", "its", "their", "they", "them", "into", "onto", "over", "under", "between", "during", "while", "using", "via", "can", "may", "might", "must", "who", "whom", "whose", "which", "what", "when", "where", "how", "why", "not", "nor", "but", "than", "then", "also", "such", "more", "most", "less", "very", "just", "only", "own", "same", "some", "any", "all", "both", "each", "every", "about", "after", "before", "again", "further", "here", "there", "upon", "within", "without", "our", "your", "his", "her", "hers", "itself", "themselves", "的", "了", "和", "是", "在", "有", "与", "就", "都", "而"]);

function tokens(text: string): string[] {
  const result: string[] = [];
  for (const word of text.toLowerCase().match(WORD) ?? []) {
    if (STOPWORDS.has(word)) continue;
    result.push(word);
    // Chinese is written without spaces, so one claim token would have to equal
    // a whole passage token to count. Bigrams give it overlapping units, which
    // also catches a term glued into a longer run. A Chinese claim against an
    // English-only passage still shares nothing, and `no_match` is then the
    // honest answer instead of a guessed quote.
    for (const run of word.match(CJK_RUN) ?? []) for (let at = 0; at + 1 < run.length; at += 1) result.push(run.slice(at, at + 2));
  }
  return result;
}

/** Okapi BM25 over the snapshot passages. Deterministic on purpose: the same
 *  claim against the same text must answer the same excerpt, or a reader who
 *  reloads the answer would see the quote move. */
function bm25(query: string[], passages: FullTextPassage[]): number[] {
  const k1 = 1.2;
  const b = 0.75;
  const documents = passages.map((passage) => tokens(passage.text));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) for (const term of new Set(document)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const totalLength = documents.reduce((sum, document) => sum + document.length, 0);
  const averageLength = documents.length ? totalLength / documents.length : 0;
  const weights = new Map<string, number>();
  for (const term of query) weights.set(term, (weights.get(term) ?? 0) + 1);
  const count = documents.length;
  return documents.map((document) => {
    const frequency = new Map<string, number>();
    for (const term of document) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    let score = 0;
    for (const [term, weight] of weights) {
      const tf = frequency.get(term) ?? 0;
      if (!tf) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
      const norm = averageLength ? document.length / averageLength : 1;
      score += weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * norm)));
    }
    return score;
  });
}

const verbatim = (needle: string, source: string): boolean => needle.length > 0 && source.includes(needle);

function locate(passages: FullTextPassage[], claim: string): CitationExcerpt[] {
  const query = tokens(claim);
  if (!query.length) return [];
  const ranked = bm25(query, passages)
    .map((score, index) => ({ score, index }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const threshold = Math.max(MIN_SCORE, (ranked[0]?.score ?? 0) * RELATIVE_CUTOFF);
  const excerpts: CitationExcerpt[] = [];
  for (const entry of ranked) {
    if (excerpts.length >= MAX_EXCERPTS) break;
    if (entry.score < threshold) break;
    const passage = passages[entry.index];
    if (!passage) continue;
    excerpts.push({
      text: passage.text,
      before: passages[entry.index - 1]?.text.slice(-NEIGHBOR_CHARS) ?? "",
      after: passages[entry.index + 1]?.text.slice(0, NEIGHBOR_CHARS) ?? "",
      section_title: passage.section_title,
      section_id: passage.section_id,
      page: passage.page,
      score: entry.score,
      passage_id: passageIdOf(passage.index),
    });
  }
  // Verbatim or nothing: every quote has to be literal text of this snapshot.
  // The slices above satisfy that by construction; the check stays because a
  // later trim, normalisation or paraphrase step in this file would otherwise
  // ship invented words wearing quotation marks.
  const snapshotText = passages.map((passage) => passage.text).join("\n");
  return excerpts.filter(
    (excerpt) =>
      verbatim(excerpt.text, snapshotText) &&
      (!excerpt.before || verbatim(excerpt.before, snapshotText)) &&
      (!excerpt.after || verbatim(excerpt.after, snapshotText)),
  );
}

function passagesCacheFile(cwd: string): string {
  return workspaceFile(cwd, "citations-passages.jsonl");
}

async function readPositionCache(cwd: string): Promise<PositionResult[]> {
  const rows = await readJsonLines<Record<string, unknown>>(passagesCacheFile(cwd));
  const results: PositionResult[] = [];
  for (const row of rows) {
    if (typeof row.key !== "string" || typeof row.claim_sha256 !== "string" || typeof row.state !== "string" || !Array.isArray(row.excerpts)) continue;
    // A row written before passages had ids cannot name the paragraph it
    // quoted, so it is dropped and the position is located again.
    if (!(row.excerpts as CitationExcerpt[]).every((excerpt) => typeof excerpt?.passage_id === "string")) continue;
    results.push({
      key: row.key,
      claim_sha256: row.claim_sha256,
      state: row.state as PositionResult["state"],
      note: typeof row.note === "string" ? row.note : null,
      snapshot_sha256: typeof row.snapshot_sha256 === "string" ? row.snapshot_sha256 : null,
      snapshot_id: typeof row.snapshot_id === "string" ? row.snapshot_id : null,
      origin: "located",
      excerpts: row.excerpts as CitationExcerpt[],
    });
  }
  return results.slice(-MAX_CACHE_ROWS);
}

export const citationPassagesService = {
  /** One result per citation position. A position this session recorded while
   *  it wrote answers from that record; only a position with no record falls
   *  back to searching the paper afterwards, and the result says which it is.
   *  A position whose full text is not on disk and may not be fetched reports
   *  `unfetched`: the answer is unknown, which is not the same as "this paper
   *  has no open text". */
  async positions(cwd: string, input: { positions: PassageRequest[]; fetch?: boolean; session_id?: string }, deps: FullTextDeps = {}): Promise<PositionResult[]> {
    const allowFetch = input.fetch !== false;
    const cache = await readPositionCache(cwd);
    // Two claims in one answer can cite the same paper; reading it twice would
    // double the provider load for one page of output.
    const snapshots = new Map<string, FullTextSnapshot | null>();
    const results: PositionResult[] = [];
    for (const request of input.positions) {
      const claim_sha256 = createHash("sha256").update(request.claim).digest("hex");
      // The model's own choice, recorded while it wrote, always wins over a
      // search: it is the paragraph the writer actually used, and re-deriving
      // it from the finished sentence can only guess.
      const recorded = input.session_id && request.claim.trim() ? await citationEvidenceService.lookup(cwd, { session_id: input.session_id, key: request.key, claim: request.claim }) : { state: "absent" as const };
      if (recorded.state === "recorded") {
        const excerpts = generationExcerpts(recorded.snapshot, recorded.record.passage_ids);
        // A record whose passages no longer resolve is not a match: saying so is
        // better than showing an empty card as if the source said nothing.
        results.push({ key: request.key, claim_sha256, state: excerpts.length ? "matched" : "stale", note: excerpts.length ? null : "the recorded passages are no longer in this snapshot", snapshot_sha256: recorded.snapshot.content_sha256, snapshot_id: snapshotIdOf(recorded.snapshot), origin: "generation", excerpts });
        continue;
      }
      if (recorded.state === "stale") {
        results.push({ key: request.key, claim_sha256, state: "stale", note: "the source was read again since this answer recorded its evidence, so the recorded passages no longer resolve", snapshot_sha256: null, snapshot_id: recorded.record.snapshot_id, origin: "generation", excerpts: [] });
        continue;
      }
      const ref = refFromKey(request.key);
      if (!ref) {
        results.push({ key: request.key, claim_sha256, state: "no_match", note: "the citation key is not a DOI or arXiv id", snapshot_sha256: null, snapshot_id: null, origin: "located", excerpts: [] });
        continue;
      }
      const sourceKey = `${ref.kind}:${ref.id}`;
      if (!snapshots.has(sourceKey)) snapshots.set(sourceKey, await fullTextSnapshot(cwd, ref, { fetch: allowFetch }, deps));
      const snapshot = snapshots.get(sourceKey) ?? null;
      if (!snapshot) {
        results.push({ key: request.key, claim_sha256, state: "unfetched", note: "full text not fetched yet", snapshot_sha256: null, snapshot_id: null, origin: "located", excerpts: [] });
        continue;
      }
      const snapshot_sha256 = snapshot.content_sha256;
      const snapshot_id = snapshotIdOf(snapshot);
      if (snapshot.state !== "available") {
        results.push({ key: request.key, claim_sha256, state: snapshot.state, note: snapshot.note, snapshot_sha256, snapshot_id, origin: "located", excerpts: [] });
        continue;
      }
      if (!snapshot.passages.length) {
        results.push({ key: request.key, claim_sha256, state: "no_match", note: "the full text holds no passages", snapshot_sha256, snapshot_id, origin: "located", excerpts: [] });
        continue;
      }
      // A cache row only answers for the exact text it was computed against. A
      // re-read paper has a new content hash, so every old row for that source
      // stops matching and the position is found again instead of quoted stale.
      const cached = cache.findLast((row) => row.key === request.key && row.claim_sha256 === claim_sha256 && row.snapshot_sha256 === snapshot_sha256);
      if (cached) {
        results.push({ ...cached, snapshot_id, origin: "located" });
        continue;
      }
      const excerpts = locate(snapshot.passages, request.claim);
      const result: PositionResult = { key: request.key, claim_sha256, state: excerpts.length ? "matched" : "no_match", note: null, snapshot_sha256, snapshot_id, origin: "located", excerpts };
      if (snapshot_sha256) {
        await appendJsonLine(passagesCacheFile(cwd), result);
        cache.push(result);
      }
      results.push(result);
    }
    return results;
  },
};
