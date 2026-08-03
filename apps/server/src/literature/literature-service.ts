import { randomBytes } from "node:crypto";
import { recordEgress } from "../security/egress-audit.js";
import { detectSensitiveTerms, type SensitiveCategory } from "../security/sensitive-terms.js";
import { combinedHash, PROVIDER_SEARCHERS, sha256Hex, type ProviderContext } from "./providers.js";
import {
  DEFAULT_PROVIDERS,
  isProviderId,
  type LiteratureProviderId,
  type LiteratureSearchOutcome,
  type LiteratureSearchResult,
  type ProviderFailure,
} from "./types.js";

/**
 * Control-plane literature gateway.
 *
 * Hard gate: every query is screened with detectSensitiveTerms BEFORE any
 * outbound request. A match blocks the search and nothing leaves the machine
 * unless the caller presents a valid approval token (issued via approve()).
 * Even approved queries are recorded in the egress audit. Results are cached
 * in memory (TTL), deduplicated across providers by stable identifier, and
 * provider failures never mask sibling results.
 */

export interface ApprovalRecord {
  queryHash: string;
  categories: SensitiveCategory[];
  expiresAt: number;
}

interface CacheEntry {
  result: LiteratureSearchResult;
  expiresAt: number;
}

export interface LiteratureServiceOptions {
  cacheTtlMs?: number;
  approvalTtlMs?: number;
  now?: () => number;
  maxQueryLength?: number;
  cache?: Map<string, CacheEntry>;
  approvals?: Map<string, ApprovalRecord>;
}

const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_QUERY_LENGTH = 500;

export class LiteratureService {
  private readonly cache: Map<string, CacheEntry>;
  private readonly approvals: Map<string, ApprovalRecord>;
  private readonly cacheTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly now: () => number;
  private readonly maxQueryLength: number;

  constructor(options: LiteratureServiceOptions = {}) {
    this.cache = options.cache ?? new Map();
    this.approvals = options.approvals ?? new Map();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxQueryLength = options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;
  }

  /** Validate the query shape; throws Error with a user-facing message. */
  private normalizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) throw new Error("query is required");
    if (trimmed.length > this.maxQueryLength) throw new Error(`query exceeds ${this.maxQueryLength} characters`);
    return trimmed;
  }

  private queryHash(query: string): string {
    return sha256Hex(query.toLowerCase());
  }

  /** True when the token is present, unexpired and covers this query + its matched categories. */
  private tokenCovers(token: string, queryHash: string, categories: SensitiveCategory[]): boolean {
    if (!token) return false;
    const record = this.approvals.get(token);
    if (!record) return false;
    if (record.expiresAt <= this.now()) {
      this.approvals.delete(token);
      return false;
    }
    if (record.queryHash !== queryHash) return false;
    return categories.every((category) => record.categories.includes(category));
  }

  /**
   * Run a literature search. Returns a blocked outcome when the query hits a
   * sensitive category and no valid approval token is supplied; otherwise
   * queries every requested provider (defaulting to all five), caching and
   * deduplicating the results.
   */
  async search(
    query: string,
    options: { providers?: readonly LiteratureProviderId[]; approvedToken?: string } = {},
  ): Promise<LiteratureSearchOutcome> {
    const normalized = this.normalizeQuery(query);
    const queryHash = this.queryHash(normalized);
    const detection = detectSensitiveTerms(normalized);
    const approved = this.tokenCovers(options.approvedToken ?? "", queryHash, detection.categories);
    // Single-use approval: a token that covers this query is consumed by the
    // search it unlocks, so the same token cannot be replayed later.
    if (approved) this.approvals.delete(options.approvedToken ?? "");
    if (detection.matched && !approved) {
      return { blocked: true, categories: detection.categories, terms: detection.terms };
    }

    const requested = options.providers && options.providers.length > 0 ? options.providers.filter(isProviderId) : DEFAULT_PROVIDERS;
    const context: ProviderContext = { approved };
    const results: LiteratureSearchResult[] = [];
    const failures: ProviderFailure[] = [];

    await Promise.all(
      requested.map(async (provider) => {
        const cacheKey = `${provider}:${normalized.toLowerCase()}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > this.now()) {
          results.push({ ...cached.result, cached: true });
          return;
        }
        try {
          const { result, rawBodies } = await PROVIDER_SEARCHERS[provider](normalized, context);
          const stored: LiteratureSearchResult = { ...result, responseHash: combinedHash(rawBodies) };
          this.cache.set(cacheKey, { result: stored, expiresAt: this.now() + this.cacheTtlMs });
          results.push(stored);
        } catch (error) {
          failures.push({ provider, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    );

    return { blocked: false, results: deduplicate(results), failures };
  }

  /**
   * Grant a short-lived approval token for a sensitive query. Records the
   * decision in the egress audit; the token expires after approvalTtlMs and
   * only covers the exact query hash and listed categories.
   */
  async approve(query: string, categories: SensitiveCategory[]): Promise<{ approvedToken: string; expiresAt: string }> {
    const normalized = this.normalizeQuery(query);
    const token = randomBytes(16).toString("hex");
    const expiresAt = this.now() + this.approvalTtlMs;
    this.approvals.set(token, { queryHash: this.queryHash(normalized), categories: [...categories], expiresAt });
    await recordEgress({
      connector_type: "literature",
      connector_id: "sensitive-approval",
      target_domain: "local-decision",
      approved: true,
      note: `approval_granted categories=${categories.join(",")}`,
    });
    return { approvedToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }
}

/** Merge results across providers by stable identifier (DOI first, then provider:id). */
export function deduplicate(results: LiteratureSearchResult[]): LiteratureSearchResult[] {
  const seen = new Set<string>();
  return results.map((result) => ({
    ...result,
    records: result.records.filter((record) => {
      const key = record.doi?.toLowerCase() || `${record.provider}:${record.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  }));
}
