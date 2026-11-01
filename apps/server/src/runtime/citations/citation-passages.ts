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
/** Bumped whenever a rule below changes a ranking. A row scored by an older
 *  ranker is dropped and the position is found again, so a fixed rule reaches
 *  the answers that were already cached against the same snapshot. */
const RANKER_VERSION = 2;

/** Sections that cannot be the paragraph a sentence rests on. They list
 *  software versions, funding, permissions or thanks. A software inventory
 *  outranks a number the claim actually quotes because it repeats version
 *  numbers on every line, so these leave the pool instead of scoring low: a
 *  scored-down inventory paragraph would still crowd out a real one when the
 *  paper is short. */
const BOILERPLATE_SECTION = /^(?:supplementar|supporting\s+information|reporting\s+summary|author\s+contribution|competing\s+interest|conflict\s+of\s+interest|publisher|editorial|additional\s+information|source\s+data|data\s+availability|code\s+availability|acknowledg|peer\s+review|ethics\s+statement)/i;

/** Where a claim's evidence usually lives, as a multiplier on the retrieval
 *  score. A Methods paragraph repeats the words of a Results claim ("training",
 *  "baseline", "model") and would otherwise win a tie it should lose. */
const SECTION_WEIGHT: Array<[RegExp, number]> = [
  [/abstract|\bmain\b|results?|discussion|conclusion|findings?/, 1.5],
  [/introduction|background/, 1.2],
  [/method|material|experimental|protocol|statistic/, 1],
];
const OTHER_SECTION_WEIGHT = 0.8;
/** A claim that quotes a number is talking about that number, so a passage
 *  reporting none of them is talking about something else. It is weighted down
 *  rather than dropped: the paper may state the same value as "0.96 Å" in one
 *  place and as "96%" in another, and a dropped passage cannot recover that. */
const MISSING_NUMBER_WEIGHT = 0.5;
/** Only a number standing on its own is a value the passage reports.
 *  `CASP14`, `AlphaFold2` and `v.1.16.4` put digits inside a name or a version,
 *  and a claim naming CASP14 would otherwise be anchored to every passage that
 *  mentions the assessment. */
const NUMBER = /(?<![\p{L}\p{N}._])\d+(?:\.\d+)*(?![\p{L}\p{N}])/gu;

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

/** "4.0" and "4" are the same reported value, so trailing zeros go before the
 *  comparison; "1.16.4" stays one token and so never equals "1.16". */
function numbersOf(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((value) => value.replace(/(?:\.0+)+$/, ""));
}

function sectionWeight(title: string | null): number {
  const text = (title ?? "").toLowerCase();
  if (!text) return 1;
  for (const [pattern, weight] of SECTION_WEIGHT) if (pattern.test(text)) return weight;
  return OTHER_SECTION_WEIGHT;
}

/** The passages worth ranking. When every passage of a paper sits in a
 *  boilerplate section the filter is skipped, because a source whose only
 *  readable text is a data statement still has text. */
function candidatePool(passages: FullTextPassage[]): FullTextPassage[] {
  const kept = passages.filter((passage) => !BOILERPLATE_SECTION.test(passage.section_title ?? ""));
  return kept.length ? kept : passages;
}

function locate(passages: FullTextPassage[], claim: string): CitationExcerpt[] {
  const query = tokens(claim);
  if (!query.length) return [];
  const pool = candidatePool(passages);
  const wanted = numbersOf(claim);
  const ranked = bm25(query, pool)
    .map((score, index) => {
      const passage = pool[index]!;
      const present = new Set(numbersOf(passage.text));
      const anchors = wanted.length && !wanted.some((number) => present.has(number)) ? MISSING_NUMBER_WEIGHT : 1;
      return { score: score * sectionWeight(passage.section_title) * anchors, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const threshold = Math.max(MIN_SCORE, (ranked[0]?.score ?? 0) * RELATIVE_CUTOFF);
  const excerpts: CitationExcerpt[] = [];
  // One paragraph per section keeps three candidates from being three
  // paragraphs of one argument. Only a named section can be deduped: a PDF text
  // layer has no section title, and there every paragraph is its own candidate.
  const seen = new Set<string>();
  for (const entry of ranked) {
    if (excerpts.length >= MAX_EXCERPTS) break;
    if (entry.score < threshold) break;
    const passage = pool[entry.index];
    if (!passage) continue;
    const section = passage.section_id ?? passage.section_title;
    if (section !== null) {
      if (seen.has(section)) continue;
      seen.add(section);
    }
    const at = passages.indexOf(passage);
    excerpts.push({
      text: passage.text,
      before: at > 0 ? passages[at - 1]?.text.slice(-NEIGHBOR_CHARS) ?? "" : "",
      after: at >= 0 ? passages[at + 1]?.text.slice(0, NEIGHBOR_CHARS) ?? "" : "",
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
    // quoted, so it is dropped and the position is located again. A row scored
    // by an older ranker is dropped for the same reason: replaying it would keep
    // showing the paragraph that rule picked.
    if (row.ranker !== RANKER_VERSION) continue;
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
        const chosen = new Set(recorded.record.passage_ids);
        // What a search of the same snapshot would have offered, kept apart from
        // the model's own choice so the card can offer it as the supplement it
        // is. It costs no request: the snapshot is the one already read.
        const supplementary = excerpts.length ? locate(recorded.snapshot.passages, request.claim).filter((excerpt) => !chosen.has(excerpt.passage_id)) : [];
        results.push({ key: request.key, claim_sha256, state: excerpts.length ? "matched" : "stale", note: excerpts.length ? null : "the recorded passages are no longer in this snapshot", snapshot_sha256: recorded.snapshot.content_sha256, snapshot_id: snapshotIdOf(recorded.snapshot), origin: "generation", excerpts, supplementary });
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
        await appendJsonLine(passagesCacheFile(cwd), { ...result, ranker: RANKER_VERSION });
        cache.push(result);
      }
      results.push(result);
    }
    return results;
  },
};
