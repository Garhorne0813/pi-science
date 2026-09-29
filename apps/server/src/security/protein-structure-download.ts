import { createMcpFetch } from "../mcp/runtime-fetch.js";
import { getUniprotEntry } from "../mcp/builtin/scientific-data-tertiary.js";
import { downloadUrl } from "./download-service.js";
import { open } from "node:fs/promises";

type StructureSource = "best_available" | "experimental" | "predicted";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function scientificFetch(url: string, init?: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  return createMcpFetch({ connectorId: "mcp_builtin_structures", endpoint: origin, allowPrivate: false })(url, init);
}

function accessionValue(value: string): string {
  const accession = value.trim().toUpperCase();
  if (!/^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){2})(?:-\d+)?$/.test(accession)) {
    throw new Error("accession must be a UniProt accession");
  }
  return accession;
}

export function verifiedProteinIdentity(value: unknown, accession: string) {
  const envelope = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const record = envelope.record && typeof envelope.record === "object" ? envelope.record as Record<string, unknown> : {};
  const organism = record.organism && typeof record.organism === "object" ? record.organism as Record<string, unknown> : {};
  const sequence = record.sequence && typeof record.sequence === "object" ? record.sequence as Record<string, unknown> : {};
  if (record.accession !== accession || typeof record.protein_name !== "string" || !record.protein_name ||
    typeof organism.scientificName !== "string" || !organism.scientificName ||
    !Number.isInteger(organism.taxonId) || Number(organism.taxonId) < 1 ||
    !Number.isInteger(sequence.length) || Number(sequence.length) < 1) {
    throw new Error(`UniProt did not return a complete identity for ${accession}`);
  }
  return {
    accession, protein_name: record.protein_name, organism_name: organism.scientificName,
    taxon_id: organism.taxonId, sequence_length: sequence.length,
    genes: Array.isArray(record.genes) ? record.genes.filter((item): item is string => typeof item === "string") : [],
    entry_id: record.entry_id, retrieved_at: envelope.retrieved_at,
  };
}

export async function resolveProteinStructure(accessionInput: string, source: StructureSource = "best_available", fetcher: Fetcher = scientificFetch) {
  const accession = accessionValue(accessionInput);
  if (!["best_available", "experimental", "predicted"].includes(source)) throw new Error("invalid structure source");
  if (source !== "predicted") {
    const query = {
      query: { type: "terminal", service: "text", parameters: {
        attribute: "rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession",
        operator: "exact_match", value: accession,
      } },
      return_type: "entry",
      request_options: { paginate: { start: 0, rows: 1 }, results_content_type: ["experimental"] },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetcher("https://search.rcsb.org/rcsbsearch/v2/query", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query), signal: AbortSignal.timeout(15_000),
        });
        if (response.status !== 204 && !response.ok) throw new Error(`RCSB search returned HTTP ${response.status}`);
        const result = response.status === 204 ? null : await response.json() as { result_set?: Array<{ identifier?: string }> };
        const pdbId = result?.result_set?.[0]?.identifier?.toUpperCase();
        if (pdbId && /^[0-9][A-Z0-9]{3}$/.test(pdbId)) {
          return { accession, source: "experimental" as const, structure_id: pdbId,
            url: `https://files.rcsb.org/download/${pdbId}.cif`, destination: `structures/${accession}/${pdbId}.cif` };
        }
        if (source === "experimental") throw new Error(`No experimental PDB structure found for ${accession}`);
        break;
      } catch (error) {
        if (attempt === 1 && source === "experimental") throw error;
      }
    }
  }
  const response = await fetcher(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`AlphaFold lookup returned HTTP ${response.status}`);
  const records = await response.json() as Array<{ uniprotAccession?: string; entryId?: string; cifUrl?: string }>;
  const record = Array.isArray(records) ? records.find((item) => item.uniprotAccession?.toUpperCase() === accession) : undefined;
  if (!record?.cifUrl || !record.entryId || !new RegExp(`^AF-${accession}-F\\d+$`).test(record.entryId)) throw new Error(`No AlphaFold structure found for ${accession}`);
  const url = new URL(record.cifUrl);
  if (url.origin !== "https://alphafold.ebi.ac.uk" || !new RegExp(`^/files/${record.entryId}-model_v\\d+\\.cif$`).test(url.pathname)) {
    throw new Error("AlphaFold returned an unexpected structure URL");
  }
  return { accession, source: "predicted" as const, structure_id: record.entryId,
    url: url.href, destination: `structures/${accession}/${url.pathname.split("/").at(-1)}` };
}

export async function downloadProteinStructure(input: { workspace: string; sessionId: string; accession: string; source?: StructureSource; destination?: string; signal?: AbortSignal }) {
  const accession = accessionValue(input.accession);
  const protein = verifiedProteinIdentity(await getUniprotEntry({ accession, include_sequence: false }), accession);
  const structure = await resolveProteinStructure(accession, input.source);
  const receipt = await downloadUrl({ workspace: input.workspace, sessionId: input.sessionId,
    url: structure.url, destination: input.destination ?? structure.destination, signal: input.signal,
    validateFile: async (path) => {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(256);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const header = buffer.subarray(0, bytesRead).toString("utf8");
        if (!header.startsWith(`data_${structure.structure_id}\n`) && !header.startsWith(`data_${structure.structure_id}\r\n`)) {
          throw new Error(`downloaded file is not the expected ${structure.structure_id} mmCIF`);
        }
      } finally { await handle.close(); }
    },
  });
  return { ...structure, protein, ...receipt, validation: `UniProt identity and ${structure.structure_id} mmCIF header verified` };
}
