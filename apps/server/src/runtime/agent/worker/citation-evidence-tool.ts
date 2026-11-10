/**
 * The two tools that let a model cite from text it actually read.
 *
 * `read_source_evidence` reads one cited source's open full text and hands back
 * numbered passages with the snapshot they came from. `cite_evidence` names the
 * ones used for a sentence. The control plane accepts a selection only for
 * passages it handed this session, so the excerpt a reader sees later is the
 * paragraph the writer chose and not a sentence found by searching afterwards.
 *
 * Neither tool judges support. A printed quotation is text from the paper; it
 * is not a finding that the paper backs the claim.
 */
import type { AgentHarnessTool, NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";

type Tool = AgentHarnessTool<{ env: NodeExecutionEnv }>;

const INTERNAL_TOKEN_HEADER = "x-pi-science-internal-token";

function backendBaseUrl(): string {
  return (process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

function headers(): Headers {
  const value = new Headers({ "content-type": "application/json" });
  const token = process.env.PI_SCIENCE_INTERNAL_TOKEN;
  if (token) value.set(INTERNAL_TOKEN_HEADER, token);
  return value;
}

interface ReadAnswer {
  source?: string;
  state?: string;
  note?: string | null;
  snapshot_id?: string | null;
  provider?: string | null;
  url?: string | null;
  retrieved_at?: string | null;
  license?: string | null;
  total?: number;
  skip?: number;
  passages?: Array<{
    passage_id: string;
    section_title: string | null;
    section_id: string | null;
    page: number | null;
    text: string;
  }>;
  error?: string;
}

interface RecordAnswer {
  accepted?: number;
  rejected?: number;
  results?: Array<{
    source: string;
    accepted: boolean;
    reason: string | null;
    note: string | null;
  }>;
  error?: string;
}

const STATE_TEXT: Record<string, string> = {
  bad_source: "the source must be doi:<id> or arxiv:<id>",
  no_open_fulltext: "this source has no open full text, so its text cannot be read or quoted",
  access_denied: "the provider refused access to the full text",
  download_failed: "the full text could not be downloaded",
  parse_failed: "the full text arrived but no paragraphs could be read from it",
  no_text_layer: "this PDF has no extractable text layer",
  version_mismatch: "only a different version of this paper is available",
  unfetched: "the full text has not been read yet",
};

export function readSourceEvidenceTool(cwd: string, sessionId: string): Tool {
  return {
    name: "read_source_evidence",
    label: "Read source evidence",
    description:
      "Read one cited source's open full text as numbered passages. Returns a snapshot_id for the read and a passage_id for each paragraph, plus its section and, when the PDF states one, its file page. PMIDs, paywalled papers and bare titles are not served; a state other than 'available' says why. Quote only passages this tool returned, and record the passages you used with cite_evidence before you finish the answer. Reading again with skip returns the next passages of the same snapshot.",
    parameters: Type.Object({
      source: Type.String({ description: "The cited source, as doi:<id> or arxiv:<id>" }),
      section: Type.Optional(
        Type.String({ description: "Only passages whose section title or id contains this text" }),
      ),
      skip: Type.Optional(
        Type.Number({
          description: "How many matching passages to skip, for reading a long paper in pages",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "How many passages to return, at most 12" })),
    }),
    async execute(_toolCallId, params, _update, _ctx, _invocation, context) {
      const input = params as { source: string; section?: string; skip?: number; limit?: number };
      const response = await fetch(
        `${backendBaseUrl()}/api/citations/evidence/read?cwd=${encodeURIComponent(cwd)}`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ session_id: sessionId, ...input }),
          signal: context.abortSignal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as ReadAnswer;
      if (!response.ok)
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `Reading the source returned HTTP ${response.status}`,
        );
      const passages = Array.isArray(body.passages) ? body.passages : [];
      if (!passages.length) {
        const reason =
          STATE_TEXT[String(body.state ?? "")] ?? body.note ?? "no passage was returned";
        return {
          content: [{ type: "text", text: `${input.source}: ${reason}.` }],
          details: { source: input.source, state: body.state ?? null, passages: 0 },
        };
      }
      const head = [
        `source: ${String(body.source ?? input.source)}`,
        `snapshot_id: ${String(body.snapshot_id)}`,
        `provider: ${String(body.provider)}`,
        `retrieved: ${String(body.retrieved_at)}`,
        body.license ? `license: ${String(body.license)}` : null,
        `passages ${passages.length ? Number(body.skip ?? 0) + 1 : 0}-${Number(body.skip ?? 0) + passages.length} of ${Number(body.total ?? passages.length)}`,
      ].filter((line): line is string => line !== null);
      const rendered = passages.map((passage) => {
        const place = [
          passage.section_title,
          passage.page === null ? null : `file page ${passage.page}`,
        ]
          .filter(Boolean)
          .join(" · ");
        return `[${passage.passage_id}]${place ? ` ${place}` : ""}\n${passage.text}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `${head.join("\n")}\n\n${rendered.join("\n\n")}\n\nThese are the paper's own paragraphs, copied verbatim. Cite a passage only after you have read it here, and call cite_evidence with the source, the sentence it belongs to, this snapshot_id and the passage ids you used. A passage you quote is not by itself a judgement that it supports the sentence.`,
          },
        ],
        details: {
          source: input.source,
          snapshot_id: body.snapshot_id ?? null,
          passages: passages.length,
          total: body.total ?? passages.length,
        },
      };
    },
  };
}

export function citeEvidenceTool(cwd: string, sessionId: string): Tool {
  return {
    name: "cite_evidence",
    label: "Record cited evidence",
    description:
      "Record which passages of which source you used for one sentence, so a reader can open exactly that text. Call this for every citation you make from text returned by read_source_evidence, before you write the final answer. The claim must be the sentence exactly as it appears in your answer. Passages you were not shown, or that belong to another snapshot, are rejected with a reason; a rejected entry is not recorded, so read the source again and select what was actually returned. If the source was only checked as metadata and its text was never read, do not call this at all: the source then shows that no generation-time text was recorded.",
    parameters: Type.Object({
      selections: Type.Array(
        Type.Object({
          source: Type.String({ description: "The cited source, as doi:<id> or arxiv:<id>" }),
          claim: Type.String({
            description: "The sentence of your answer this citation sits in, copied exactly",
          }),
          snapshot_id: Type.String({
            description: "The snapshot_id read_source_evidence returned",
          }),
          passage_ids: Type.Array(Type.String(), {
            description: "The passage ids from that read that this sentence rests on",
          }),
        }),
        { description: "One entry per citation position", maxItems: 30 },
      ),
    }),
    async execute(_toolCallId, params, _update, _ctx, _invocation, context) {
      const input = params as {
        selections: Array<{
          source: string;
          claim: string;
          snapshot_id: string;
          passage_ids: string[];
        }>;
      };
      const response = await fetch(
        `${backendBaseUrl()}/api/citations/evidence?cwd=${encodeURIComponent(cwd)}`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ session_id: sessionId, selections: input.selections }),
          signal: context.abortSignal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as RecordAnswer;
      if (!response.ok)
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : `Recording evidence returned HTTP ${response.status}`,
        );
      const results = Array.isArray(body.results) ? body.results : [];
      const lines = results.map((result) =>
        result.accepted
          ? `RECORDED ${result.source}: this sentence will open the passages you named`
          : `REJECTED ${result.source} (${String(result.reason)}): ${String(result.note ?? "not recorded")}`,
      );
      const rejected = results.filter((result) => !result.accepted);
      return {
        content: [
          {
            type: "text",
            text: `${lines.join("\n")}\n\n${Number(body.accepted ?? 0)} recorded, ${Number(body.rejected ?? 0)} rejected.${rejected.length ? " A rejected citation has no recorded text: read the source with read_source_evidence and select a passage it returned, or state in the answer only what you verified from metadata." : ""} A recorded passage is the text you selected, not a judgement that it supports the sentence.`,
          },
        ],
        details: { accepted: Number(body.accepted ?? 0), rejected: Number(body.rejected ?? 0) },
      };
    },
  };
}
