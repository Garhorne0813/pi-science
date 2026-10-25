/**
 * Citation verification against free, public scholarly APIs.
 *
 * Every citation in agent output (DOI or arXiv id) is resolved through
 * Crossref / Unpaywall / arXiv for metadata, abstract and open-access links,
 * plus a retraction check via Crossref update-to links. Results are cached in
 * the workspace as evidence snapshots so re-verification is incremental.
 * No paid or proprietary citation databases are used.
 */
import { createHash } from "node:crypto";
import { appendJsonLine, configPath, readJson, readJsonLines, workspaceFile } from "../../storage/persistence.js";
import { recordEgress } from "../../security/egress-audit.js";

export interface CitationRef {
  kind: "doi" | "arxiv";
  id: string;
}

export interface CitationEvidence {
  kind: "doi" | "arxiv";
  id: string;
  status: "found" | "not_found";
  title: string | null;
  authors: string[];
  journal: string | null;
  year: string | null;
  abstract: string | null;
  oa_url: string | null;
  retracted: boolean;
  retraction_note: string | null;
  verified_at: string;
}

export interface VerifyCitationsResult {
  text_sha256: string;
  citations: Array<CitationEvidence & { cached: boolean }>;
}

export interface CitationDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

const DOI_PATTERN = /10\.\d{4,9}\/[^\s)\]}>]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*"']+$/;
const MAX_CITATIONS_PER_CALL = 30;
const MAX_ABSTRACT_CHARS = 2_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Per-domain minimum interval, mirroring the paper-search connector. */
const MINIMUM_INTERVAL: Record<string, number> = { "api.crossref.org": 50, "api.unpaywall.org": 350, "export.arxiv.org": 3_000 };
const UNPAYWALL_EMAIL_CONFIG = "citation_verify_email";

const lastRequestAt = new Map<string, number>();

/** Extract DOI and arXiv identifiers from text, deduped in first-seen order.
 *  Rule-compatible with the frontend citations module. */
export function extractCitations(text: string): CitationRef[] {
  const found: Array<CitationRef & { index: number }> = [];
  for (const match of text.matchAll(DOI_PATTERN)) {
    const id = match[0].replace(TRAILING_PUNCTUATION, "").toLowerCase();
    if (id.endsWith("/")) continue;
    found.push({ kind: "doi", id, index: match.index ?? 0 });
  }
  for (const match of text.matchAll(ARXIV_PATTERN)) {
    found.push({ kind: "arxiv", id: match[1]!.replace(/v\d+$/, ""), index: match.index ?? 0 });
  }
  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const citations: CitationRef[] = [];
  for (const { kind, id } of found) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ kind, id });
  }
  return citations.slice(0, MAX_CITATIONS_PER_CALL);
}

function citationCacheFile(cwd: string): string {
  return workspaceFile(cwd, "citations.jsonl");
}

async function readCache(cwd: string): Promise<Map<string, CitationEvidence>> {
  const rows = await readJsonLines<{ kind?: string; id?: string } & Partial<CitationEvidence>>(citationCacheFile(cwd));
  const cache = new Map<string, CitationEvidence>();
  for (const row of rows) {
    if (!row.kind || !row.id || !row.verified_at) continue;
    const key = `${row.kind}:${row.id}`;
    const existing = cache.get(key);
    // Keep the newest snapshot per citation.
    if (!existing || existing.verified_at < row.verified_at) {
      cache.set(key, {
        kind: row.kind as "doi" | "arxiv",
        id: row.id,
        status: row.status === "not_found" ? "not_found" : "found",
        title: row.title ?? null,
        authors: Array.isArray(row.authors) ? row.authors : [],
        journal: row.journal ?? null,
        year: row.year ?? null,
        abstract: row.abstract ?? null,
        oa_url: row.oa_url ?? null,
        retracted: Boolean(row.retracted),
        retraction_note: row.retraction_note ?? null,
        verified_at: row.verified_at,
      });
    }
  }
  return cache;
}

async function fetchJson(url: URL, deps: CitationDeps, domain: string): Promise<unknown> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  // Throttle per domain before touching the network.
  const interval = MINIMUM_INTERVAL[domain] ?? 350;
  for (;;) {
    const last = lastRequestAt.get(domain) ?? 0;
    const wait = last + interval - now();
    if (wait <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt.set(domain, now());
  await recordEgress({ connector_type: "literature", connector_id: "citation-verify", target_domain: domain, approved: true });
  const response = await fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${domain} returned HTTP ${response.status}`);
  return await response.json();
}

function crossrefEvidence(doi: string, works: Record<string, unknown>): CitationEvidence {
  const message = (works.message ?? {}) as Record<string, unknown>;
  const updateTo = Array.isArray(message["update-to"]) ? (message["update-to"] as Array<Record<string, unknown>>) : [];
  const retraction = updateTo.find((link) => String(link.type ?? "").toLowerCase() === "retraction");
  const assertions = Array.isArray(message.assertion) ? (message.assertion as Array<Record<string, unknown>>) : [];
  const assertionNote = assertions.find((item) => /retract/i.test(String(item.label ?? "")));
  const issued = (message.issued ?? {}) as Record<string, unknown>;
  const dateParts = Array.isArray(issued["date-parts"]) ? (issued["date-parts"] as number[][]) : [];
  const authors = Array.isArray(message.author) ? (message.author as Array<Record<string, unknown>>).map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean) : [];
  const abstract = typeof message.abstract === "string" ? message.abstract.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  return {
    kind: "doi",
    id: doi,
    status: "found",
    title: typeof message.title === "string" ? message.title : Array.isArray(message.title) ? String(message.title[0] ?? "") : null,
    authors,
    journal: Array.isArray(message["container-title"]) ? String(message["container-title"][0] ?? "") || null : null,
    year: dateParts[0]?.[0] ? String(dateParts[0][0]) : null,
    abstract: abstract ? abstract.slice(0, MAX_ABSTRACT_CHARS) : null,
    oa_url: null,
    retracted: Boolean(retraction || assertionNote),
    retraction_note: retraction ? String(retraction.label ?? "A retraction notice is linked to this DOI") : assertionNote ? String(assertionNote.label) : null,
    verified_at: new Date().toISOString(),
  };
}

async function verifyDoi(doi: string, cwd: string, deps: CitationDeps): Promise<CitationEvidence> {
  const works = await fetchJson(new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`), deps, "api.crossref.org") as { message?: Record<string, unknown> } | null;
  if (!works?.message) {
    return { kind: "doi", id: doi, status: "not_found", title: null, authors: [], journal: null, year: null, abstract: null, oa_url: null, retracted: false, retraction_note: null, verified_at: new Date().toISOString() };
  }
  const evidence = crossrefEvidence(doi, works);
  // Unpaywall needs a configured contact email; without one we degrade to
  // Crossref metadata only instead of sending a placeholder address.
  const config = await readJson<Record<string, unknown>>(configPath("config.json"), {});
  const email = String(config[UNPAYWALL_EMAIL_CONFIG] ?? "").trim() || String(process.env.PI_SCIENCE_CITATION_EMAIL ?? "").trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    try {
      const unpaywall = await fetchJson(new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`), deps, "api.unpaywall.org") as Record<string, unknown> | null;
      const best = unpaywall?.best_oa_location as Record<string, unknown> | undefined;
      if (best?.url_for_landing_page || best?.url_for_pdf) {
        evidence.oa_url = String(best.url_for_pdf ?? best.url_for_landing_page);
      }
    } catch {
      // Open-access enrichment is best-effort; metadata alone still verifies.
    }
  }
  return evidence;
}

async function verifyArxiv(id: string, deps: CitationDeps): Promise<CitationEvidence> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("id_list", id);
  url.searchParams.set("max_results", "1");
  const response = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await recordEgress({ connector_type: "literature", connector_id: "citation-verify", target_domain: "export.arxiv.org", approved: true });
  if (!response.ok) throw new Error(`export.arxiv.org returned HTTP ${response.status}`);
  const xml = await response.text();
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1] ?? "";
  const tag = (name: string) => (new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim();
  if (!entry) {
    return { kind: "arxiv", id, status: "not_found", title: null, authors: [], journal: null, year: null, abstract: null, oa_url: null, retracted: false, retraction_note: null, verified_at: new Date().toISOString() };
  }
  return {
    kind: "arxiv",
    id,
    status: "found",
    title: tag("title") || null,
    authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((match) => match[1]!.replace(/\s+/g, " ").trim()).filter(Boolean),
    journal: null,
    year: tag("published").slice(0, 4) || null,
    abstract: tag("summary").slice(0, MAX_ABSTRACT_CHARS) || null,
    oa_url: `https://arxiv.org/abs/${id}`,
    retracted: false,
    retraction_note: null,
    verified_at: new Date().toISOString(),
  };
}

export const citationVerifyService = {
  /** Verify all citations in a text; cached snapshots are reused until stale. */
  async verify(cwd: string, input: { text: string }, deps: CitationDeps = {}): Promise<VerifyCitationsResult> {
    const now = deps.now ?? Date.now;
    const refs = extractCitations(String(input.text ?? ""));
    const cache = await readCache(cwd);
    const results: Array<CitationEvidence & { cached: boolean }> = [];
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`;
      const cached = cache.get(key);
      if (cached && now() - Date.parse(cached.verified_at) < CACHE_TTL_MS) {
        results.push({ ...cached, cached: true });
        continue;
      }
      let evidence: CitationEvidence;
      try {
        evidence = ref.kind === "doi" ? await verifyDoi(ref.id, cwd, deps) : await verifyArxiv(ref.id, deps);
      } catch (error) {
        // A provider hiccup must not fail the whole verification; record a
        // not_found snapshot with the reason so the agent tells the truth.
        evidence = {
          kind: ref.kind, id: ref.id, status: "not_found", title: null, authors: [], journal: null, year: null,
          abstract: null, oa_url: null, retracted: false,
          retraction_note: `verification request failed: ${error instanceof Error ? error.message : String(error)}`,
          verified_at: new Date().toISOString(),
        };
      }
      await appendJsonLine(citationCacheFile(cwd), evidence);
      results.push({ ...evidence, cached: false });
    }
    return {
      text_sha256: createHash("sha256").update(String(input.text ?? "")).digest("hex"),
      citations: results,
    };
  },

  /** Look up cached evidence snapshots without contacting any provider. */
  async lookup(cwd: string, ids: string[]): Promise<CitationEvidence[]> {
    const cache = await readCache(cwd);
    return ids.slice(0, MAX_CITATIONS_PER_CALL).flatMap((raw) => {
      const [kind, ...rest] = raw.split(":");
      const id = rest.join(":");
      if ((kind !== "doi" && kind !== "arxiv") || !id) return [];
      const hit = cache.get(`${kind}:${id}`);
      return hit ? [hit] : [];
    });
  },
};
