/** Agent-facing adapter for control-plane downloads. Only this adapter asks
 * the user for a host grant; the sandbox never receives general network access. */
const urlSchema = {
  type: "object", additionalProperties: false,
  required: ["url", "destination"],
  properties: {
    url: { type: "string", description: "HTTPS URL of a public data file" },
    destination: { type: "string", description: "Workspace-relative output path" },
    expected_sha256: { type: "string", description: "Optional expected SHA-256 checksum" },
    max_bytes: { type: "integer", minimum: 1, maximum: 268435456, description: "Maximum download size in bytes" },
  },
};

const structureSchema = {
  type: "object", additionalProperties: false,
  required: ["accession"],
  properties: {
    accession: { type: "string", description: "Exact UniProt accession, such as P30520" },
    source: { type: "string", enum: ["best_available", "experimental", "predicted"], description: "Optional structure preference; best_available prefers an experimental PDB structure" },
    destination: { type: "string", description: "Optional workspace-relative output path" },
  },
};

async function request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const base = (process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.PI_SCIENCE_INTERNAL_TOKEN) headers["x-pi-science-internal-token"] = process.env.PI_SCIENCE_INTERNAL_TOKEN;
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
  const value = await response.json() as any;
  if (!response.ok && value?.code !== "network_access_required") throw new Error(value?.error || `Download failed (${response.status})`);
  return value;
}

export default function registerDownload(pi: any): void {
  pi.registerTool({
    name: "download_url", label: "Download URL", parameters: urlSchema,
    description: "Download a public HTTPS URL to a workspace-relative destination. Requires url and destination; asks for host access and publishes an artifact.",
    promptSnippet: "Use download_url only when you already have a specific public HTTPS file URL and a workspace-relative destination.",
    execute: (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => executeDownload("url", params, signal, ctx),
  });
  pi.registerTool({
    name: "download_protein_structure", label: "Download Protein Structure", parameters: structureSchema,
    description: "Given an exact UniProt accession, verify protein identity, select an experimental PDB structure or AlphaFold prediction, download and validate one mmCIF, and publish it as an artifact. No URL is needed.",
    promptSnippet: "For one protein structure from an exact UniProt accession, call download_protein_structure with accession once. Report the verified protein identity, source and artifact from its result. Use structure lookup MCP tools only when the user asks for search or comparison.",
    execute: (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) => executeDownload("structure", params, signal, ctx),
  });
}

async function executeDownload(kind: "url" | "structure", params: any, signal: AbortSignal | undefined, ctx: any) {
  try {
        // The Orbit host is shared by workspaces. Its process environment
        // points at orbit-host, while ctx.cwd belongs to this session.
        const cwd = ctx?.cwd;
        if (!cwd) throw new Error("Session workspace is unavailable");
        const sessionId = ctx.sessionManager.getSessionId();
        const structure = kind === "structure";
        if (structure ? !params.accession || params.url || params.expected_sha256 || params.max_bytes : !params.url || !params.destination || params.accession || params.source) {
          throw new Error(structure ? "Provide accession and optional destination" : "Provide url and destination");
        }
        const body = structure
          ? { cwd, session_id: sessionId, accession: params.accession, ...(params.destination ? { destination: params.destination } : {}), ...(params.source ? { source: params.source } : {}) }
          : { cwd, session_id: sessionId, url: params.url, destination: params.destination, ...(params.expected_sha256 ? { expected_sha256: params.expected_sha256 } : {}), ...(params.max_bytes ? { max_bytes: params.max_bytes } : {}) };
        const route = structure ? "/api/downloads/protein-structure" : "/api/downloads";
        for (let attempt = 0; attempt < 7; attempt += 1) {
          const result = await request(route, body, signal);
          if (result.code !== "network_access_required") {
            const summary = structure
              ? `UniProt verified: ${result.protein.protein_name} (${result.protein.organism_name}; taxon ${result.protein.taxon_id}; ${result.protein.sequence_length} aa${result.protein.genes?.length ? `; genes ${result.protein.genes.join(", ")}` : ""}), accession ${result.accession}. Downloaded and validated ${result.source} structure ${result.structure_id}: ${result.destination} (${result.size} bytes, SHA-256 ${result.sha256}). ${result.validation}. Artifact ${result.artifact_id ?? "unavailable"}.`
              : `Downloaded ${result.destination} (${result.size} bytes, SHA-256 ${result.sha256}). Artifact ${result.artifact_id ?? "unavailable"}.`;
            return { content: [{ type: "text", text: summary }], details: result };
          }
          const choice = await ctx.ui.select(`Allow HTTPS downloads from ${result.host} for this session?`, ["Allow for this session", "Deny"]);
          if (choice !== "Allow for this session") throw new Error(`Network access to ${result.host} was denied`);
          await request("/api/downloads/grants", { cwd, session_id: sessionId, url: `https://${result.host}/` }, signal);
        }
        throw new Error("Download crossed too many unapproved hosts");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Download error: ${message}` }], details: { error: message }, isError: true };
  }
}
