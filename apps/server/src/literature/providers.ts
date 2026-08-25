import { createHash } from "node:crypto";
import { recordEgress } from "../security/egress-audit.js";
import { safeConnectorFetch } from "../security/outbound-security.js";
import { emptySearchResult, type LiteratureProviderId, type LiteratureRecord, type LiteratureSearchResult } from "./types.js";

/**
 * Provider implementations for the literature gateway. Every outbound call
 * goes through safeConnectorFetch (SSRF guard, redirect re-validation, size
 * caps, timeout), is recorded in the egress audit, and is throttled per
 * provider to stay inside the official rate limits (NCBI ~3 req/s without an
 * API key). Providers are pure functions over (query, context); the service
 * layer owns caching, approvals and cross-provider dedup.
 */

export interface ProviderContext {
  /** True when the caller holds a valid approval token for a sensitive query. */
  approved: boolean;
}

export interface ProviderResult {
  result: LiteratureSearchResult;
  /** Raw response bodies in request order; used to compute the combined hash. */
  rawBodies: string[];
}

const BUCKET_INTERVAL_MS: Record<string, number> = {
  ncbi: 700, // NCBI: ~3 req/s without an API key; each search issues esearch + esummary
  arxiv: 1200, // arXiv API TOU asks for polite use
  pubchem: 250,
  uniprot: 250,
};

/** NCBI E-utilities databases (pubmed + nuccore) share one rate bucket. */
const PROVIDER_BUCKET: Record<LiteratureProviderId, string> = {
  pubmed: "ncbi",
  genbank: "ncbi",
  arxiv: "arxiv",
  pubchem: "pubchem",
  uniprot: "uniprot",
};

const lastRequestAt = new Map<string, number>();
const throttleTails = new Map<string, Promise<void>>();

type ThrottleTurn = { predecessor: Promise<void>; tail: Promise<void>; release: () => void };

function enqueueThrottle(key: string): ThrottleTurn {
  const predecessor = throttleTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = predecessor.then(() => turn);
  throttleTails.set(key, tail);
  return { predecessor, tail, release };
}

async function waitForThrottle(turn: ThrottleTurn, key: string, minIntervalMs: number): Promise<void> {
  await turn.predecessor;
  const now = Date.now();
  const last = lastRequestAt.get(key) ?? 0;
  const wait = last + minIntervalMs - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt.set(key, Date.now());
}

function releaseThrottle(key: string, turn: ThrottleTurn): void {
  turn.release();
  if (throttleTails.get(key) === turn.tail) throttleTails.delete(key);
}

/** Serialize calls per rate bucket and enforce a minimum interval between them. */
export async function throttle(key: string, minIntervalMs = BUCKET_INTERVAL_MS[key] ?? 250): Promise<void> {
  const turn = enqueueThrottle(key);
  try {
    await waitForThrottle(turn, key, minIntervalMs);
  } finally {
    releaseThrottle(key, turn);
  }
}

/** Reset throttle state (tests). */
export function resetThrottle(): void {
  lastRequestAt.clear();
  throttleTails.clear();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function combinedHash(bodies: readonly string[]): string {
  return bodies.length === 0 ? sha256Hex("") : sha256Hex(bodies.join("\x00"));
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value
    .replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArxivId(raw: string): string {
  const match = /(\d{4}\.\d{4,5})(?:v\d+)?/.exec(raw);
  return match?.[1] ?? raw;
}

async function fetchProviderText(provider: LiteratureProviderId, url: string, context: ProviderContext): Promise<string> {
  await recordEgress({
    connector_type: "literature",
    connector_id: provider,
    target_domain: url,
    approved: context.approved,
    note: "provider_search",
  });
  const response = await safeConnectorFetch(url, { timeoutMs: 20_000, maxResponseBytes: 8 * 1024 * 1024, allowPrivate: false });
  if (!response.ok) throw new Error(`provider ${provider} responded ${response.status} ${response.statusText}`);
  return response.text();
}

async function runThrottled(provider: LiteratureProviderId, context: ProviderContext, fetcher: () => Promise<string[]>): Promise<ProviderResult> {
  const bucket = PROVIDER_BUCKET[provider];
  const turn = enqueueThrottle(bucket);
  try {
    await waitForThrottle(turn, bucket, BUCKET_INTERVAL_MS[bucket] ?? 250);
    const rawBodies = await fetcher();
    return {
      result: {
        provider,
        query: "",
        hitCount: 0,
        truncated: false,
        records: [],
        retrievedAt: new Date().toISOString(),
        responseHash: combinedHash(rawBodies),
        cached: false,
      },
      rawBodies,
    };
  } finally {
    // Hold the bucket turn for the whole provider operation, so a multi-step
    // call (NCBI search + summary) cannot overlap the next caller.
    releaseThrottle(bucket, turn);
  }
}

function withQuery(query: string, result: LiteratureSearchResult): LiteratureSearchResult {
  return { ...result, query };
}

/** NCBI E-utilities: esearch + esummary for pubmed or nuccore (GenBank) databases. */
async function ncbiSearch(db: "pubmed" | "nuccore", provider: "pubmed" | "genbank", query: string, context: ProviderContext): Promise<ProviderResult> {
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=${db}&term=${encodeURIComponent(query)}&retmode=json&retmax=10`;
  const summary = await runThrottled(provider, context, async () => {
    const searchBody = await fetchProviderText(provider, searchUrl, context);
    const parsed = JSON.parse(searchBody) as { esearchresult?: { idlist?: string[]; retmax?: string } };
    const ids = parsed.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [searchBody];
    await new Promise((resolve) => setTimeout(resolve, BUCKET_INTERVAL_MS[PROVIDER_BUCKET[provider]] ?? 250)); // space esearch/esummary within one search
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=${db}&id=${ids.join(",")}&retmode=json`;
    const summaryBody = await fetchProviderText(provider, summaryUrl, context);
    return [searchBody, summaryBody];
  });
  const searchParsed = JSON.parse(summary.rawBodies[0] ?? "{}") as { esearchresult?: { idlist?: string[]; retmax?: string } };
  const ids = searchParsed.esearchresult?.idlist ?? [];
  if (ids.length === 0) return { result: withQuery(query, emptySearchResult(provider, query, summary.result.responseHash)), rawBodies: summary.rawBodies };

  let records: LiteratureRecord[] = [];
  if (summary.rawBodies.length > 1) {
    const summaryParsed = JSON.parse(summary.rawBodies[1] ?? "{}") as {
      result?: Record<string, { uid?: string; title?: string; pubdate?: string; source?: string; authors?: Array<{ name?: string }>; articleids?: Array<{ idtype?: string; value?: string }>; caption?: string; accession?: string }>;
    };
    records = ids
      .map((id) => summaryParsed.result?.[id])
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => {
        const id = entry.accession ?? entry.caption ?? entry.uid ?? "";
        const doi = entry.articleids?.find((article) => article.idtype === "doi")?.value;
        const pubdate = entry.pubdate ?? "";
        const year = Number.parseInt(pubdate.slice(0, 4), 10);
        return {
          id,
          provider,
          title: entry.title ?? "(untitled)",
          authors: (entry.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
          year: Number.isFinite(year) ? year : undefined,
          venue: entry.source,
          url: db === "nuccore" ? `https://www.ncbi.nlm.nih.gov/nuccore/${id}` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
          doi,
          extra: db === "nuccore" ? { database: "GenBank" } : undefined,
        };
      });
  }
  const result = withQuery(query, {
    ...summary.result,
    hitCount: records.length,
    records,
  });
  return { result, rawBodies: summary.rawBodies };
}

export async function searchPubMed(query: string, context: ProviderContext): Promise<ProviderResult> {
  return ncbiSearch("pubmed", "pubmed", query, context);
}

export async function searchGenBank(query: string, context: ProviderContext): Promise<ProviderResult> {
  return ncbiSearch("nuccore", "genbank", query, context);
}

/** arXiv API (Atom XML). */
export async function searchArxiv(query: string, context: ProviderContext): Promise<ProviderResult> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=10`;
  const summary = await runThrottled("arxiv", context, async () => {
    const body = await fetchProviderText("arxiv", url, context);
    return [body];
  });
  const body = summary.rawBodies[0] ?? "";
  const records: LiteratureRecord[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(body)) !== null) {
    const block = match[1] ?? "";
    const idMatch = /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/.exec(block);
    const titleMatch = /<title>\s*([\s\S]*?)\s*<\/title>/.exec(block);
    const publishedMatch = /<published>\s*(\d{4})-(\d{2})-(\d{2})/.exec(block);
    if (!idMatch) continue;
    const id = normalizeArxivId(idMatch[1] ?? "");
    const authorMatches = [...block.matchAll(/<name>\s*([\s\S]*?)\s*<\/name>/g)].map((author) => decodeXml(author[1] ?? ""));
    records.push({
      id,
      provider: "arxiv",
      title: decodeXml(titleMatch?.[1] ?? "(untitled)"),
      authors: authorMatches,
      year: publishedMatch ? Number(publishedMatch[1]) : undefined,
      url: `https://arxiv.org/abs/${id}`,
      extra: { published: publishedMatch ? `${publishedMatch[1]}-${publishedMatch[2]}-${publishedMatch[3]}` : undefined },
    });
  }
  const result = withQuery(query, { ...summary.result, hitCount: records.length, records });
  return { result, rawBodies: summary.rawBodies };
}

/** PubChem REST: name -> CIDs, then molecular properties. */
export async function searchPubChem(query: string, context: ProviderContext): Promise<ProviderResult> {
  const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON`;
  const summary = await runThrottled("pubchem", context, async () => {
    const cidBody = await fetchProviderText("pubchem", cidUrl, context);
    const cidParsed = JSON.parse(cidBody) as { IdentifierList?: { CID?: Array<number | string> } };
    const cids = (cidParsed.IdentifierList?.CID ?? []).slice(0, 10);
    if (cids.length === 0) return [cidBody];
    const propUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cids.join(",")}/property/MolecularFormula,MolecularWeight,IUPACName/JSON`;
    const propBody = await fetchProviderText("pubchem", propUrl, context);
    return [cidBody, propBody];
  });
  const cidParsed = JSON.parse(summary.rawBodies[0] ?? "{}") as { IdentifierList?: { CID?: Array<number | string> } };
  const cids = (cidParsed.IdentifierList?.CID ?? []).slice(0, 10);
  let records: LiteratureRecord[] = [];
  if (cids.length > 0 && summary.rawBodies.length > 1) {
    const propParsed = JSON.parse(summary.rawBodies[1] ?? "{}") as {
      PropertyTable?: { Properties?: Array<{ CID?: number | string; MolecularFormula?: string; MolecularWeight?: number; IUPACName?: string }> };
    };
    records = (propParsed.PropertyTable?.Properties ?? []).map((property) => {
      const cid = String(property.CID ?? "");
      return {
        id: cid,
        provider: "pubchem",
        title: property.IUPACName ?? property.MolecularFormula ?? `PubChem CID ${cid}`,
        url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
        extra: { molecularFormula: property.MolecularFormula, molecularWeight: property.MolecularWeight },
      };
    });
  }
  const result = withQuery(query, { ...summary.result, hitCount: records.length, records });
  return { result, rawBodies: summary.rawBodies };
}

/** UniProtKB REST search. */
export async function searchUniProt(query: string, context: ProviderContext): Promise<ProviderResult> {
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&format=json&size=10`;
  const summary = await runThrottled("uniprot", context, async () => {
    const body = await fetchProviderText("uniprot", url, context);
    return [body];
  });
  const parsed = JSON.parse(summary.rawBodies[0] ?? "{}") as {
    results?: Array<{
      primaryAccession?: string;
      uniProtkbId?: string;
      proteinDescription?: { recommendedName?: { fullName?: { value?: string } } };
      organism?: { scientificName?: string };
      genes?: Array<{ geneName?: { value?: string } }>;
    }>;
  };
  const records: LiteratureRecord[] = (parsed.results ?? []).map((entry) => {
    const accession = entry.primaryAccession ?? "";
    const gene = entry.genes?.[0]?.geneName?.value;
    return {
      id: accession,
      provider: "uniprot",
      title: entry.proteinDescription?.recommendedName?.fullName?.value ?? entry.uniProtkbId ?? accession,
      venue: entry.organism?.scientificName,
      url: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
      extra: { uniprotId: entry.uniProtkbId, gene },
    };
  });
  const result = withQuery(query, { ...summary.result, hitCount: records.length, records });
  return { result, rawBodies: summary.rawBodies };
}

export const PROVIDER_SEARCHERS: Record<LiteratureProviderId, (query: string, context: ProviderContext) => Promise<ProviderResult>> = {
  pubmed: searchPubMed,
  genbank: searchGenBank,
  arxiv: searchArxiv,
  pubchem: searchPubChem,
  uniprot: searchUniProt,
};
