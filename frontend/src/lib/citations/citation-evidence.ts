import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useRuntimeStore } from "../agent-runtime";
import { apiRequest } from "../client/api";
import { configQuery } from "../settings/settings-api";
import type { CitationInlineStyle } from "../settings/settings-types";

/** One source as the workspace snapshot holds it. `found` is a provider answer
 *  about the identifier, not a judgement that the paper supports the sentence
 *  citing it; retraction and the answer-versus-record comparison travel beside
 *  the status so a reader never has to read one as the other. */
export interface CitationEvidence {
  kind: "doi" | "arxiv";
  /** The identifier as cited, arXiv version suffix included. Snapshot rows
   *  carry it; the card's own read keys by it so two cited versions of one
   *  paper never share a row. */
  requested_id?: string;
  id: string;
  status: "found" | "not_found" | "error" | "unchecked";
  title: string | null;
  authors: string[];
  journal: string | null;
  year: string | null;
  /** Crossref's own numbering of the issue the record appeared in. arXiv has
   *  no such fields, so it leaves all three null; a missing one is omitted,
   *  never filled in. */
  volume: string | null;
  issue: string | null;
  pages: string | null;
  abstract: string | null;
  oa_url: string | null;
  retraction: "retracted" | "clear" | "unknown";
  retraction_note: string | null;
  retraction_url: string | null;
  checked_providers: string[];
  error: string | null;
  status_note: string | null;
  bibliographic: "match" | "mismatch" | "not_compared";
  bibliographic_note: string | null;
  version: "confirmed" | "unconfirmed" | "not_applicable";
  requested_version: string | null;
  record_version: string | null;
  verified_at: string;
}

/** What the card can say about a check. Retraction, version and the
 *  answer-versus-record comparison are separate notices, because none of them
 *  is a lookup state: a source can be found and retracted, or found and
 *  contradicted by the reference entry the answer printed. */
export type CitationCardState = "unchecked" | "checking" | "found" | "not_found" | "error";

export function citationCardState(evidence: CitationEvidence | undefined, checking = false): CitationCardState {
  if (checking) return "checking";
  if (!evidence || evidence.status === "unchecked") return "unchecked";
  if (evidence.status === "found") return "found";
  if (evidence.status === "error") return "error";
  return "not_found";
}

/** Automatic verification runs after the turn settles, so the first snapshot can
 *  predate the evidence. Poll until it lands, but stop: a switch turned off
 *  mid-turn, or a server that never answers, must not poll forever. */
const SNAPSHOT_POLL_MS = 3_000;
const MAX_SNAPSHOT_POLLS = 60;

export const citationSnapshotKey = (cwd: string, text: string) => ["citations", cwd, text] as const;

/** One source's own read, under the same `["citations"]` root as the snapshot
 *  it also writes to: a check invalidates that root and every view of the same
 *  source — card and reference list — refetches together. */
export const citationSourceKey = (cwd: string, citationKey: string) => ["citations", "source", cwd, citationKey] as const;

/** The composite `kind:requestedId` key a snapshot row is filed under. The
 *  version the answer cited is part of the key, so an arXiv paper cited at two
 *  versions keeps two rows instead of one overwriting the other. */
export const citationEvidenceKey = (row: Pick<CitationEvidence, "kind" | "id" | "requested_id">): string => `${row.kind}:${row.requested_id ?? row.id}`;

export interface CitationEvidenceSet {
  bySource: Map<string, CitationEvidence>;
  unprocessed: Array<{ kind: string; requested_id: string }>;
}

/** The one read of a message's citation snapshot. The reference list, the body
 *  badge and the card all read it, so a source can never show one state in the
 *  list and another in the card. */
export function useCitationEvidence(cwd: string, text: string, streaming = false): CitationEvidenceSet {
  const { data: config } = useQuery(configQuery<{ citation_auto_verify?: boolean }>(cwd));
  const polls = useRef(0);
  useEffect(() => { polls.current = 0; }, [text]);
  const { data } = useQuery({
    queryKey: citationSnapshotKey(cwd, text),
    // The workspace travels with the request: the server scopes the snapshot to
    // it, and without it the read falls back to the server's own directory.
    queryFn: () => {
      polls.current += 1;
      return apiRequest<{ citations: CitationEvidence[]; unprocessed?: Array<{ kind: string; requested_id: string }> }>(`/api/citations/snapshot?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    },
    // Streaming rewrites the answer text on every token, and the text is the
    // query key: wait for the final text instead of posting each partial one.
    enabled: Boolean(cwd) && Boolean(text.trim()) && !streaming,
    refetchInterval: (query) => {
      const pending = (query.state.data?.citations ?? []).some((row) => row.status === "unchecked");
      return config?.citation_auto_verify === true && pending && polls.current < MAX_SNAPSHOT_POLLS ? SNAPSHOT_POLL_MS : false;
    },
    staleTime: 60_000,
    retry: false,
  });
  return {
    bySource: new Map((data?.citations ?? []).map((row) => [citationEvidenceKey(row), row])),
    unprocessed: data?.unprocessed ?? [],
  };
}

/** The snapshot of one source, read without contacting a provider. Opening a
 *  card is a read of what the workspace already holds. */
export function useCitationSource(cwd: string, citationKey: string | undefined, enabled: boolean): CitationEvidence | undefined {
  const { data } = useQuery({
    queryKey: citationSourceKey(cwd, citationKey ?? ""),
    queryFn: () => apiRequest<{ citations: CitationEvidence[] }>(`/api/citations?${new URLSearchParams({ cwd, ids: citationKey ?? "" })}`),
    enabled: enabled && Boolean(cwd) && Boolean(citationKey),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return data?.citations?.[0];
}

/** The body marker style the reader chose. An absent or unreadable value is the
 *  default, `number`. */
export function useCitationInlineStyle(cwd: string): CitationInlineStyle {
  const { data } = useQuery(configQuery<{ citation_inline_style?: CitationInlineStyle }>(cwd));
  return data?.citation_inline_style === "identifier" ? "identifier" : "number";
}

/** The check action's own state, so a card can show the check it started. */
export type CitationCheck = ReturnType<typeof useVerifyCitation>;

/** Check the sources named here, and only those. `refresh` re-queries instead
 *  of replaying a snapshot taken before a rate limit or an outage. This runs
 *  whether or not automatic verification is on: a manual check is the reader's
 *  own request. */
export function useVerifyCitation(cwd: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, refresh }: { ids: string[]; refresh?: boolean }) =>
      apiRequest<{ citations: CitationEvidence[] }>(`/api/citations/verify?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, refresh }) }),
    // The answer is what the card must show next, so it is written to the
    // source read directly; invalidating the `citations` root then refreshes
    // the snapshot the reference list reads. Without the write the card kept
    // showing the state it had before the check.
    onSuccess: (result, { ids }) => {
      for (const row of result.citations ?? []) {
        const key = citationEvidenceKey(row);
        if (ids.includes(key)) client.setQueryData(citationSourceKey(cwd, key), { citations: [row] });
      }
      void client.invalidateQueries({ queryKey: ["citations"] });
    },
  });
}

/** The identifier the card and the list link to, resolved from the same
 *  `kind:requestedId` key the body marker carries. */
export function citationResolver(key: string): { kind: "doi" | "arxiv"; id: string; url: string } | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!id) return null;
  if (kind === "doi") return { kind, id, url: `https://doi.org/${id}` };
  if (kind === "arxiv") return { kind, id, url: `https://arxiv.org/abs/${id}` };
  return null;
}

export function useCitationCwd(): string {
  return useRuntimeStore((state) => state.cwd);
}

/** The session whose evidence a card may read. Generation-time evidence is
 *  recorded per session, so an answer in another session can never open this
 *  one's passages. */
export function useCitationSession(): string | null {
  return useRuntimeStore((state) => state.activeSessionId);
}
