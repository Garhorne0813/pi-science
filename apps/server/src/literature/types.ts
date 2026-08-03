import type { SensitiveCategory } from "../security/sensitive-terms.js";

/** Providers backed by official public APIs (no third-party MCP shims). */
export type LiteratureProviderId = "pubmed" | "genbank" | "arxiv" | "pubchem" | "uniprot";

export const PROVIDER_IDS: readonly LiteratureProviderId[] = ["pubmed", "genbank", "arxiv", "pubchem", "uniprot"];

export const DEFAULT_PROVIDERS: readonly LiteratureProviderId[] = ["pubmed", "genbank", "arxiv", "pubchem", "uniprot"];

export function isProviderId(value: string): value is LiteratureProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** One normalized record returned by a provider. */
export interface LiteratureRecord {
  /** Stable identifier: PMID/accession, arXiv id (canonical NNNN.NNNNN), PubChem CID, UniProt accession. */
  id: string;
  provider: LiteratureProviderId;
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  url: string;
  doi?: string;
  extra?: Record<string, unknown>;
}

/** Raw provider outcome for one provider+query. */
export interface LiteratureSearchResult {
  provider: LiteratureProviderId;
  query: string;
  hitCount: number;
  truncated: boolean;
  records: LiteratureRecord[];
  /** ISO 8601 UTC retrieval timestamp. */
  retrievedAt: string;
  /** sha256 of the raw provider response(s) that produced this result. */
  responseHash: string;
  cached: boolean;
}

export interface ProviderFailure {
  provider: LiteratureProviderId;
  error: string;
}

export type LiteratureSearchOutcome =
  | {
      blocked: true;
      categories: SensitiveCategory[];
      terms: string[];
    }
  | {
      blocked: false;
      results: LiteratureSearchResult[];
      failures: ProviderFailure[];
    };

export function emptySearchResult(provider: LiteratureProviderId, query: string, responseHash: string): LiteratureSearchResult {
  return {
    provider,
    query,
    hitCount: 0,
    truncated: false,
    records: [],
    retrievedAt: new Date().toISOString(),
    responseHash,
    cached: false,
  };
}
