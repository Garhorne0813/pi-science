/**
 * Open full text for one cited source, fetched once and stored as passages.
 *
 * The source card answers "what is this paper" from metadata. This module
 * answers the next question, "what does the paper actually say there", so a
 * reader can see the sentence behind a citation number without leaving the
 * answer. Passages are the unit: split once at fetch time, stored verbatim, so
 * every later excerpt is copied text rather than model paraphrase.
 *
 * Only open full text is read, in a fixed order: Europe PMC open-access XML,
 * arXiv's own HTML, and the open-access PDF an OA index already pointed at.
 * There is no login, no paywall circumvention and no browser automation, so a
 * source that is not open is reported as such. `access_denied`, a failed
 * download and a body that could not be parsed are three different answers and
 * are never collapsed into "this paper does not exist".
 */
import { createHash } from "node:crypto";
import { constants as zlibConstants, inflateRawSync, inflateSync } from "node:zlib";
import { arxivIdOf, arxivVersionOf } from "@pi-science/contracts";
import { readJson, readJsonLines, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import { recordEgress } from "../../security/egress-audit.js";
import { safeConnectorFetch, validateConnectorOutboundUrl, type ConnectorLookup } from "../../security/outbound-security.js";

export type FullTextState = "available" | "no_open_fulltext" | "access_denied" | "download_failed" | "parse_failed" | "no_text_layer" | "version_mismatch";

export interface FullTextPassage { index: number; section_title: string | null; section_id: string | null; page: number | null; text: string }

export interface FullTextSnapshot {
  kind: "doi" | "arxiv";
  id: string;
  requested_id: string;
  requested_version: string | null;
  state: FullTextState;
  note: string | null;
  provider: "europepmc" | "arxiv_html" | "open_pdf" | null;
  url: string | null;
  retrieved_at: string | null;
  content_sha256: string | null;
  license: string | null;
  sections: Array<{ id: string | null; title: string | null }>;
  passages: FullTextPassage[];
}

export interface FullTextRef { kind: "doi" | "arxiv"; id: string; requested_id: string; requested_version: string | null }

export interface FullTextDeps {
  /** Transport and name resolution for fixtures. Production leaves both unset,
   *  so every request goes through the restricted connector fetch. */
  fetch?: typeof fetch;
  lookup?: ConnectorLookup;
  now?: () => number;
  /** Per-domain minimum interval in ms, so tests need not sleep. */
  minimumInterval?: Record<string, number>;
}

export interface FullTextReadOptions {
  /** `false` reads the snapshot already on disk and never contacts a provider. */
  fetch?: boolean;
  /** Ignore a fresh snapshot, e.g. a manual "re-read the paper" action. */
  refresh?: boolean;
}

const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** A body past these sizes is a mislabelled dataset or an error page, not the
 *  paper a reader asked about, and reading it would only cost memory. */
const MAX_TEXT_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
/** The PDF route states its own type, so a landing page that answers instead of
 *  the file is refused before its bytes are parsed. */
const PDF_CONTENT_TYPES = ["application/pdf", "application/octet-stream", "binary/octet-stream"];
/** Per-domain minimum interval, mirroring the citation verify conventions. */
const MINIMUM_INTERVAL: Record<string, number> = { "www.ebi.ac.uk": 350, "arxiv.org": 3_000 };
/** A paragraph shorter than this is a label ("Table 1."), not a sentence
 *  worth ranking: keeping them only adds noise the reader has to skip. */
const MIN_PASSAGE_CHARS = 24;
/** One passage stays near a paragraph, so `before`/`after` really are the
 *  neighbouring paragraphs instead of the whole page. */
const MAX_PASSAGE_CHARS = 700;
const STATES: FullTextState[] = ["available", "no_open_fulltext", "access_denied", "download_failed", "parse_failed", "no_text_layer", "version_mismatch"];

const lastRequestAt = new Map<string, number>();

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Where the current read of one source is kept. The requested version belongs
 *  in the name: two versions of one paper are different text, and a citation of
 *  v2 must never be answered from a cached v1. */
export function fullTextSnapshotPath(cwd: string, kind: FullTextRef["kind"], id: string, requestedVersion: string | null = null): string {
  const version = requestedVersion ? `-${requestedVersion}` : "";
  return workspaceFile(cwd, `citations-fulltext/${kind}-${createHash("sha1").update(id).digest("hex")}${version}.json`);
}

/** Identity of one stored read of a source: the source, the version asked for
 *  and the bytes that came back. Re-reading the same bytes answers the same id,
 *  so a citation recorded against it still resolves; a paper that changed
 *  answers a new one, and an old record is then reported as stale instead of
 *  being pointed at text it never saw. */
export function snapshotIdOf(snapshot: Pick<FullTextSnapshot, "kind" | "id" | "requested_version" | "content_sha256">): string | null {
  if (!snapshot.content_sha256) return null;
  return sha256(`${snapshot.kind}\u0000${snapshot.id}\u0000${snapshot.requested_version ?? ""}\u0000${snapshot.content_sha256}`).slice(0, 24);
}

/** A passage's identity inside one snapshot. `index` is the position the
 *  snapshot stored it at, so the pair names one verbatim paragraph and a
 *  re-fetched paper cannot inherit it. */
export function passageIdOf(index: number): string {
  return `p${index}`;
}

/** Where one observed read of a source is kept, so evidence recorded against it
 *  still resolves after the source is fetched again. */
export function fullTextVersionPath(cwd: string, kind: FullTextRef["kind"], id: string, snapshotId: string): string {
  return workspaceFile(cwd, `citations-fulltext-versions/${kind}-${createHash("sha1").update(id).digest("hex")}-${snapshotId}.json`);
}

/** The source key a citation carries, resolved to the reference a snapshot is
 *  filed under. A DOI is stored in its canonical lowercase form, and an arXiv id
 *  keeps the version the answer cited, so v1 and v2 never share a snapshot. */
export function refFromKey(key: string): FullTextRef | null {
  const at = key.indexOf(":");
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const requestedId = key.slice(at + 1);
  if ((kind !== "doi" && kind !== "arxiv") || !requestedId) return null;
  return kind === "doi"
    ? { kind, id: requestedId.toLowerCase(), requested_id: requestedId, requested_version: null }
    : { kind, id: arxivIdOf(requestedId), requested_id: requestedId, requested_version: arxivVersionOf(requestedId) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A stored snapshot is only reused when it still describes the same source;
 *  a file written for another id would hand this citation someone else's text. */
async function readSnapshotFile(path: string, kind: FullTextRef["kind"], id: string): Promise<FullTextSnapshot | null> {
  const raw = await readJson<Record<string, unknown> | null>(path, null);
  if (!raw || raw.kind !== kind || raw.id !== id || !STATES.includes(raw.state as FullTextState)) return null;
  const sections = Array.isArray(raw.sections) ? raw.sections.filter((entry): entry is { id: string | null; title: string | null } => typeof entry === "object" && entry !== null) : [];
  const passages = Array.isArray(raw.passages) ? raw.passages.filter((entry): entry is FullTextPassage => typeof entry === "object" && entry !== null && typeof (entry as FullTextPassage).text === "string") : [];
  return {
    kind,
    id,
    requested_id: typeof raw.requested_id === "string" ? raw.requested_id : id,
    requested_version: typeof raw.requested_version === "string" ? raw.requested_version : null,
    state: raw.state as FullTextState,
    note: typeof raw.note === "string" ? raw.note : null,
    provider: raw.provider === "europepmc" || raw.provider === "arxiv_html" || raw.provider === "open_pdf" ? raw.provider : null,
    url: typeof raw.url === "string" ? raw.url : null,
    retrieved_at: typeof raw.retrieved_at === "string" ? raw.retrieved_at : null,
    content_sha256: typeof raw.content_sha256 === "string" ? raw.content_sha256 : null,
    license: typeof raw.license === "string" ? raw.license : null,
    sections: sections.map((entry) => ({ id: typeof entry.id === "string" ? entry.id : null, title: typeof entry.title === "string" ? entry.title : null })),
    passages: passages.map((entry, index) => ({
      index: typeof entry.index === "number" ? entry.index : index,
      section_title: typeof entry.section_title === "string" ? entry.section_title : null,
      section_id: typeof entry.section_id === "string" ? entry.section_id : null,
      page: typeof entry.page === "number" ? entry.page : null,
      text: entry.text,
    })),
  };
}

/** The current read of one source, for the version the citation names. A file
 *  written for another version of the same paper is not an answer: it reads as
 *  no stored text, and the requested version is fetched instead. */
export async function readFullTextSnapshot(cwd: string, kind: FullTextRef["kind"], id: string, requestedVersion: string | null = null): Promise<FullTextSnapshot | null> {
  const snapshot = await readSnapshotFile(fullTextSnapshotPath(cwd, kind, id, requestedVersion), kind, id);
  return snapshot && (snapshot.requested_version ?? null) === requestedVersion ? snapshot : null;
}

async function throttle(domain: string, deps: FullTextDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const interval = deps.minimumInterval?.[domain] ?? MINIMUM_INTERVAL[domain] ?? 350;
  for (;;) {
    const last = lastRequestAt.get(domain) ?? 0;
    const wait = last + interval - now();
    // The interval is a gap between requests, not a deadline: a clock that moved
    // backwards must not turn into an hour-long sleep inside a request.
    if (wait <= 0 || wait > interval) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt.set(domain, now());
}

type BytesAnswer = { ok: true; url: string; bytes: Buffer } | { ok: false; state: FullTextState; note: string };

/** What one route may read: the cap on bytes and, where the route states its
 *  own type, the types that answer for the document. */
interface FetchLimits { maxBytes: number; allowedContentTypes?: readonly string[] }

const TEXT_LIMITS: FetchLimits = { maxBytes: MAX_TEXT_BYTES };
const PDF_LIMITS: FetchLimits = { maxBytes: MAX_PDF_BYTES, allowedContentTypes: PDF_CONTENT_TYPES };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One reader for every provider. The address is checked before the request is
 *  recorded, and the restricted connector fetch checks it again on arrival and
 *  on every redirect hop, caps the body whether or not the response declared a
 *  length, and applies one deadline to the whole read. */
async function fetchBytes(url: URL, deps: FullTextDeps, limits: FetchLimits): Promise<BytesAnswer> {
  const domain = url.hostname;
  const options = { allowPrivate: false, lookup: deps.lookup };
  try {
    await validateConnectorOutboundUrl(url.toString(), options);
  } catch (error) {
    // Nothing left the process, so this is not an outage the reader may retry:
    // the deployment is not allowed to reach the address the link names.
    return { ok: false, state: "download_failed", note: `${domain} refused by the outbound policy: ${messageOf(error)}` };
  }
  try {
    await throttle(domain, deps);
    // The audit normalizes a URL to its host, so the URL is passed rather than
    // the bare domain the throttle keys on.
    await recordEgress({ connector_type: "literature", connector_id: "citation-fulltext", target_domain: url.toString(), approved: true });
    const response = await safeConnectorFetch(url.toString(), {
      ...options,
      maxResponseBytes: limits.maxBytes,
      allowedContentTypes: limits.allowedContentTypes,
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl: deps.fetch,
    });
    if (response.status === 404 || response.status === 410) return { ok: false, state: "no_open_fulltext", note: `${domain} holds no full text at this address (HTTP ${response.status})` };
    // 402 is a payment demand: a closed paper, which is a refusal and not an
    // outage, and never a reason to look for a copy somewhere unapproved.
    if (response.status === 401 || response.status === 402 || response.status === 403) return { ok: false, state: "access_denied", note: `${domain} refused access (HTTP ${response.status})` };
    if (!response.ok) return { ok: false, state: "download_failed", note: `${domain} answered HTTP ${response.status}` };
    const bytes = Buffer.from(await response.arrayBuffer());
    // Bytes that arrived but say nothing are a parse problem: repeating the
    // same request would only produce the same empty body.
    if (!bytes.length) return { ok: false, state: "parse_failed", note: `${domain} returned an empty body` };
    return { ok: true, url: url.toString(), bytes };
  } catch (error) {
    return { ok: false, state: "download_failed", note: `${domain} request failed: ${messageOf(error)}` };
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 ? String.fromCodePoint(point) : all;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Markup to readable text. MathML is dropped whole: its inner text is a token
 *  soup (a lone "𝛼" per glyph) that would only compete with real words, and a
 *  formula is not the sentence a reader is looking for. */
function plainText(markup: string): string {
  return decodeEntities(
    markup
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<math\b[\s\S]*?<\/math>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedMarkup { sections: Array<{ id: string | null; title: string | null }>; passages: FullTextPassage[]; license: string | null }

/** Both JATS and arXiv HTML wrap prose in `<p>` inside a `<sec>`/`<section>`
 *  block, so one splitter serves both: everything up to the next block belongs
 *  to the block that opened it, which is what gives each passage its section. */
function sectionsFromBlocks(markup: string, openTag: RegExp, defaultTitle: (tag: string) => string | null): ParsedMarkup {
  const sections: Array<{ id: string | null; title: string | null }> = [];
  const passages: FullTextPassage[] = [];
  for (const chunk of markup.split(openTag)) {
    const tag = /^<([a-z]+)\b([^>]*)>/i.exec(chunk);
    if (!tag) continue;
    const sectionId = /\bid="([^"]*)"/i.exec(tag[2] ?? "")?.[1] ?? null;
    const heading = /<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>|<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(chunk);
    const title = plainText(heading?.[1] ?? heading?.[2] ?? "") || defaultTitle((tag[1] ?? "").toLowerCase());
    if (title && !sections.some((entry) => entry.id === sectionId && entry.title === title)) sections.push({ id: sectionId, title });
    for (const paragraph of chunk.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = plainText(paragraph[1] ?? "");
      if (text.length < MIN_PASSAGE_CHARS) continue;
      passages.push({ index: passages.length, section_title: title, section_id: sectionId, page: null, text });
    }
  }
  return { sections, passages, license: null };
}

function parseEpmcXml(xml: string): ParsedMarkup {
  if (!/<article\b|<body\b/.test(xml)) return { sections: [], passages: [], license: null };
  const parsed = sectionsFromBlocks(xml, /(?=<(?:sec|abstract|body|back)\b)/i, (tag) => (tag === "abstract" ? "Abstract" : null));
  const href = /<license\b[^>]*xlink:href="([^"]+)"/i.exec(xml)?.[1];
  const licenseText = href ? null : /<license\b[^>]*>([\s\S]*?)<\/license>/i.exec(xml)?.[1];
  const license = href ?? (licenseText ? plainText(licenseText).slice(0, 200) || null : null);
  return { ...parsed, license };
}

function parseArxivHtml(html: string): ParsedMarkup {
  // The section number is rendered as its own tag span; keeping it would put
  // "1 " in front of every title the reader sees.
  const trimmed = html.replace(/<span\b[^>]*ltx_tag[^>]*>[\s\S]*?<\/span>/gi, " ");
  const href = /<a\b[^>]*rel="license"[^>]*href="([^"]+)"/i.exec(html)?.[1] ?? /<a\b[^>]*href="([^"]+)"[^>]*rel="license"/i.exec(html)?.[1];
  return { ...sectionsFromBlocks(trimmed, /(?=<section\b)/i, () => null), license: href ?? null };
}

/* ------------------------------------------------------------------------- *
 * PDF text layer
 *
 * Only the text layer is read: the bytes of `BT`/`ET` blocks with `Tj`/`TJ`
 * operators. No OCR, no rendering, no layout guesswork. A scanned PDF has no
 * text layer, and saying `no_text_layer` is the honest answer.
 * ------------------------------------------------------------------------- */

const PDF_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

function pdfLiteral(value: string): string {
  return value.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (all, code: string) => PDF_ESCAPES[code] ?? String.fromCharCode(Number.parseInt(code, 8) || 0));
}

const SHOW_TEXT = /\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^()\\])*)\)\s*Tj/gs;
const TEXT_BLOCK = /BT\b([\s\S]*?)ET\b/g;

function pdfBlockText(block: string): string {
  const pieces: string[] = [];
  for (const match of block.matchAll(SHOW_TEXT)) {
    // A TJ array is one run split by kerning, so its strings join without a
    // space; separate Tj operators each are their own word and need one.
    pieces.push(match[1] !== undefined ? [...match[1].matchAll(/\(((?:\\.|[^()\\])*)\)/gs)].map((part) => pdfLiteral(part[1] ?? "")).join("") : pdfLiteral(match[2] ?? ""));
  }
  return pieces.join(" ").replace(/\s+/g, " ").trim();
}

function pdfContentText(content: string): string[] {
  const blocks: string[] = [];
  for (const match of content.matchAll(TEXT_BLOCK)) {
    const text = pdfBlockText(match[1] ?? "");
    // A bare page number is a running footer, not prose the reader came for.
    if (text.length < 2 || /^\d{1,4}$/.test(text)) continue;
    blocks.push(text);
  }
  return blocks;
}

function pdfStreamData(objectBody: string): string | null {
  const start = objectBody.indexOf("stream");
  const end = objectBody.lastIndexOf("endstream");
  if (start < 0 || end < start) return null;
  const head = objectBody.slice(0, start);
  let from = start + "stream".length;
  if (objectBody[from] === "\r") from += 1;
  if (objectBody[from] === "\n") from += 1;
  const data = Buffer.from(objectBody.slice(from, end), "latin1");
  if (!/\/FlateDecode/.test(head)) return data.toString("latin1");
  // Writers leave a newline or padding after the deflate stream; Z_SYNC_FLUSH
  // accepts that tail instead of failing the whole page on it.
  try { return inflateSync(data).toString("latin1"); } catch { /* try the next strategy */ }
  try { return inflateSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("latin1"); } catch { /* try the next strategy */ }
  try { return inflateRawSync(data).toString("latin1"); } catch { return null; }
}

function pdfPageOrder(objects: Map<number, string>): { pages: number[]; confirmed: boolean } {
  const pages: number[] = [];
  const walk = (objectNumber: number, depth: number): void => {
    const body = objects.get(objectNumber) ?? "";
    if (!body || depth > 8) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(body)) { pages.push(objectNumber); return; }
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? "";
    for (const kid of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(kid[1]), depth + 1);
  };
  for (const [objectNumber, body] of objects) if (/\/Type\s*\/Pages\b/.test(body) && /\/Kids\b/.test(body) && !/\/Parent\b/.test(body)) walk(objectNumber, 0);
  if (pages.length) return { pages, confirmed: true };
  // No page tree to walk: object order is the only order left, so these
  // positions are not confirmed file pages and the passage carries no page.
  return { pages: [...objects.entries()].filter(([, body]) => /\/Type\s*\/Page\b(?!s)/.test(body)).map(([objectNumber]) => objectNumber), confirmed: false };
}

function pdfPageContentRefs(pageBody: string): number[] {
  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageBody)?.[1];
  const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageBody)?.[1];
  const source = array ?? (single ? `${single} 0 R` : "");
  return [...source.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

function pdfParagraphs(page: number | null, blocks: string[], startIndex: number): FullTextPassage[] {
  const passages: FullTextPassage[] = [];
  let current = "";
  const flush = (): void => {
    if (current) passages.push({ index: startIndex + passages.length, section_title: null, section_id: null, page, text: current });
    current = "";
  };
  for (const block of blocks) {
    if (current && current.length + block.length + 1 > MAX_PASSAGE_CHARS) flush();
    current = current ? `${current} ${block}` : block;
    if (/[.!?。！？]$/.test(current) && current.length >= MAX_PASSAGE_CHARS / 2) flush();
  }
  flush();
  return passages;
}

type PdfParse = { ok: true; pages: Array<{ page: number | null; blocks: string[] }> } | { ok: false; state: "parse_failed" | "no_text_layer"; note: string };

function parsePdf(bytes: Buffer): PdfParse {
  const raw = bytes.toString("latin1");
  if (!raw.startsWith("%PDF")) return { ok: false, state: "parse_failed", note: "the download is not a PDF file" };
  if (/\/Encrypt\b/.test(raw)) return { ok: false, state: "parse_failed", note: "the PDF is encrypted, so its text layer cannot be read" };
  const objects = new Map<number, string>();
  for (const match of raw.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/g)) {
    const objectNumber = Number(match[1]);
    if (!objects.has(objectNumber)) objects.set(objectNumber, match[2] ?? "");
  }
  const order = pdfPageOrder(objects);
  const pages = order.pages.map((objectNumber, position) => {
    const content = pdfPageContentRefs(objects.get(objectNumber) ?? "").map((ref) => pdfStreamData(objects.get(ref) ?? "") ?? "").join("\n");
    return { page: order.confirmed ? position + 1 : null, blocks: pdfContentText(content) };
  });
  if (!pages.some((entry) => entry.blocks.length)) return { ok: false, state: "no_text_layer", note: "the PDF is readable but holds no extractable text layer (a scan needs OCR, not this reader)" };
  return { ok: true, pages };
}

interface ProviderAnswer {
  provider: "europepmc" | "arxiv_html" | "open_pdf";
  url: string;
  body: string;
  license: string | null;
  sections: Array<{ id: string | null; title: string | null }>;
  passages: FullTextPassage[];
}

type Attempt = { ok: true; answer: ProviderAnswer } | { ok: false; state: FullTextState; note: string };

const absent = (note: string): Attempt => ({ ok: false, state: "no_open_fulltext", note });

async function europepmcAttempt(ref: FullTextRef, deps: FullTextDeps): Promise<Attempt> {
  const search = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  // Preprints have no PMCID of their own; Europe PMC indexes the ones it holds
  // under the arXiv DOI, so both kinds ask by DOI and the answer is checked.
  search.searchParams.set("query", `DOI:"${ref.kind === "arxiv" ? `10.48550/arXiv.${ref.id}` : ref.id}"`);
  search.searchParams.set("format", "json");
  search.searchParams.set("resultType", "core");
  search.searchParams.set("pageSize", "5");
  const found = await fetchBytes(search, deps, TEXT_LIMITS);
  if (!found.ok) return found;
  let records: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(found.bytes.toString("utf8")) as Record<string, unknown>;
    const list = (parsed.resultList ?? {}) as Record<string, unknown>;
    records = Array.isArray(list.result) ? (list.result as Array<Record<string, unknown>>) : [];
  } catch {
    return { ok: false, state: "parse_failed", note: "europepmc search answered with no JSON" };
  }
  const wanted = (ref.kind === "arxiv" ? `10.48550/arxiv.${ref.id}` : ref.id).toLowerCase();
  const hit = records.find((record) => String(record.doi ?? "").toLowerCase() === wanted && typeof record.pmcid === "string" && record.pmcid);
  const pmcid = hit ? String(hit.pmcid) : "";
  if (!pmcid) return absent(`europepmc: no open-access full text for ${ref.kind}:${ref.id}`);
  const full = await fetchBytes(new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`), deps, TEXT_LIMITS);
  if (!full.ok) return full.state === "no_open_fulltext" ? absent(`europepmc: ${pmcid} has no full-text XML`) : full;
  const xml = full.bytes.toString("utf8");
  const parsed = parseEpmcXml(xml);
  if (!parsed.passages.length) return { ok: false, state: "parse_failed", note: "europepmc full-text XML held no paragraphs" };
  return { ok: true, answer: { provider: "europepmc", url: full.url, body: xml, license: parsed.license, sections: parsed.sections, passages: parsed.passages } };
}

async function arxivHtmlAttempt(ref: FullTextRef, deps: FullTextDeps): Promise<Attempt> {
  const full = await fetchBytes(new URL(`https://arxiv.org/html/${encodeURIComponent(ref.requested_id)}`), deps, TEXT_LIMITS);
  if (!full.ok) return full.state === "no_open_fulltext" ? absent("arxiv: no HTML rendering for this id") : full;
  const html = full.bytes.toString("utf8");
  const declared = new RegExp(`${escapeRegExp(ref.id)}v(\\d+)`).exec(html)?.[1] ?? null;
  // The version-qualified URL is what arXiv was asked for, and the page also
  // states the version it renders. A page that states another version is the
  // wrong text, so it is reported instead of falling through to a PDF of the
  // current version: the reader asked about the version the answer cited.
  if (ref.requested_version && declared && declared !== ref.requested_version) return { ok: false, state: "version_mismatch", note: `arxiv served v${declared} for a citation of v${ref.requested_version}` };
  if (!/<section\b/i.test(html)) return absent("arxiv: the HTML page has no section markup");
  const parsed = parseArxivHtml(html);
  if (!parsed.passages.length) return { ok: false, state: "parse_failed", note: "arxiv HTML held no paragraphs" };
  return { ok: true, answer: { provider: "arxiv_html", url: full.url, body: html, license: parsed.license, sections: parsed.sections, passages: parsed.passages } };
}

/** The OA link is what the metadata check already stored. A source with no OA
 *  link has no open PDF to read, so the PDF route is skipped rather than
 *  guessed at. */
async function openPdfLink(cwd: string, ref: FullTextRef): Promise<string | null> {
  const rows = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "citations.jsonl"));
  let best: { url: string; at: string } | null = null;
  for (const row of rows) {
    if (row.kind !== ref.kind || String(row.id ?? "").toLowerCase() !== ref.id.toLowerCase()) continue;
    if (typeof row.oa_url !== "string") continue;
    const at = String(row.verified_at ?? "");
    if (!best || at > best.at) best = { url: row.oa_url, at };
  }
  return best?.url ?? null;
}

async function openPdfAttempt(cwd: string, ref: FullTextRef, deps: FullTextDeps): Promise<Attempt> {
  const link = await openPdfLink(cwd, ref);
  if (!link) return absent("open_pdf: no open-access link was recorded for this source");
  if (!/\.pdf(?:$|[?#])/i.test(link)) return absent(`open_pdf: the open-access link is not a PDF (${link.slice(0, 120)})`);
  const full = await fetchBytes(new URL(link), deps, PDF_LIMITS);
  if (!full.ok) return full;
  const parsed = parsePdf(full.bytes);
  if (!parsed.ok) return parsed;
  const passages: FullTextPassage[] = [];
  for (const page of parsed.pages) passages.push(...pdfParagraphs(page.page, page.blocks, passages.length));
  const body = parsed.pages.map((page) => page.blocks.join(" ")).join("\n");
  return { ok: true, answer: { provider: "open_pdf", url: full.url, body, license: null, sections: [], passages } };
}

/** The most informative failure wins when no provider served: a refusal says
 *  something quite different from an outage, and neither means "no such paper". */
const FAILURE_PRIORITY: FullTextState[] = ["version_mismatch", "access_denied", "download_failed", "parse_failed", "no_text_layer"];

function failureState(attempts: Attempt[]): FullTextState {
  for (const state of FAILURE_PRIORITY) if (attempts.some((attempt) => !attempt.ok && attempt.state === state)) return state;
  return "no_open_fulltext";
}

function emptySnapshot(ref: FullTextRef, state: FullTextState, note: string | null, retrievedAt: string | null): FullTextSnapshot {
  return { kind: ref.kind, id: ref.id, requested_id: ref.requested_id, requested_version: ref.requested_version, state, note, provider: null, url: null, retrieved_at: retrievedAt, content_sha256: null, license: null, sections: [], passages: [] };
}

/** Fetch and store the snapshot for one source. The attempt is written even
 *  when it failed: a refusal or an outage is remembered, so opening the same
 *  citation again does not repeat a request the provider just rejected. */
export async function fetchFullTextSnapshot(cwd: string, ref: FullTextRef, deps: FullTextDeps = {}): Promise<FullTextSnapshot> {
  const now = deps.now ?? Date.now;
  const attempts: Attempt[] = [];
  let answer: ProviderAnswer | null = null;
  const providers: Array<ProviderAnswer["provider"]> = ref.kind === "arxiv" ? ["europepmc", "arxiv_html", "open_pdf"] : ["europepmc", "open_pdf"];
  for (const provider of providers) {
    const attempt = provider === "europepmc" ? await europepmcAttempt(ref, deps) : provider === "arxiv_html" ? await arxivHtmlAttempt(ref, deps) : await openPdfAttempt(cwd, ref, deps);
    if (attempt.ok) { answer = attempt.answer; break; }
    attempts.push(attempt);
    // A version mismatch is an answer about this citation, not a provider that
    // could not serve, so asking the next provider for a different text is wrong.
    if (attempt.state === "version_mismatch") break;
  }
  const retrievedAt = new Date(now()).toISOString();
  if (!answer) {
    const state = failureState(attempts);
    const snapshot = emptySnapshot(ref, state, attempts.map((attempt) => (attempt.ok ? "" : attempt.note)).filter(Boolean).join("; ") || null, retrievedAt);
    await writeJsonAtomic(fullTextSnapshotPath(cwd, ref.kind, ref.id, ref.requested_version), snapshot);
    return snapshot;
  }
  const versionNote = ref.requested_version && !new RegExp(`${escapeRegExp(ref.id)}v(\\d+)`).test(answer.body) ? "arxiv HTML does not state which version it renders" : null;
  const snapshot: FullTextSnapshot = {
    kind: ref.kind,
    id: ref.id,
    requested_id: ref.requested_id,
    requested_version: ref.requested_version,
    state: "available",
    note: answer.provider === "arxiv_html" ? versionNote : null,
    provider: answer.provider,
    url: answer.url,
    retrieved_at: retrievedAt,
    content_sha256: sha256(answer.body),
    license: answer.license,
    sections: answer.sections,
    passages: answer.passages,
  };
  await writeJsonAtomic(fullTextSnapshotPath(cwd, ref.kind, ref.id, ref.requested_version), snapshot);
  // The read that answered this fetch is kept beside the current snapshot. A
  // citation recorded against it has to keep resolving after the paper is
  // fetched again, and overwriting the one file would have erased its text.
  const snapshotId = snapshotIdOf(snapshot);
  if (snapshotId) await writeJsonAtomic(fullTextVersionPath(cwd, snapshot.kind, snapshot.id, snapshotId), snapshot);
  return snapshot;
}

/** One source read as an old citation recorded it, read back by the id that
 *  citation carries. A version file that no longer describes the same source
 *  answers null rather than someone else's text. */
export async function readFullTextVersion(cwd: string, kind: FullTextRef["kind"], id: string, snapshotId: string): Promise<FullTextSnapshot | null> {
  const snapshot = await readSnapshotFile(fullTextVersionPath(cwd, kind, id, snapshotId), kind, id);
  return snapshot && snapshotIdOf(snapshot) === snapshotId ? snapshot : null;
}

/** Read the snapshot on disk, fetching only when it is missing or older than
 *  the freshness window. A new body replaces the old one wholesale, so the
 *  passage locator can key its cache on `content_sha256` and never answer
 *  against text that has since changed. `fetch: false` returns null when
 *  nothing is stored: a source that was never read is not a source without
 *  full text. */
export async function fullTextSnapshot(cwd: string, ref: FullTextRef, options: FullTextReadOptions = {}, deps: FullTextDeps = {}): Promise<FullTextSnapshot | null> {
  const cached = await readFullTextSnapshot(cwd, ref.kind, ref.id, ref.requested_version);
  const now = (deps.now ?? Date.now)();
  if (cached && !options.refresh && now - Date.parse(cached.retrieved_at ?? "") < SNAPSHOT_TTL_MS) return cached;
  if (options.fetch === false) return cached;
  return await fetchFullTextSnapshot(cwd, ref, deps);
}
