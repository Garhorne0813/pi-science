import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpConnectorCreate, McpToolSummary } from "@pi-science/contracts";

export interface BuiltinMcpConnector {
  connector_id: string;
  definition: Omit<McpConnectorCreate, "enabled">;
  tools: McpToolSummary[];
}

export function builtinMcpConnectors(): BuiltinMcpConnector[] {
  const runtime = paperSearchRuntime();
  return [{
    connector_id: "mcp_builtin_paper_search",
    definition: {
      name: "paper-search",
      display_name: "Paper Search",
      description: "Search PubMed, arXiv, and Crossref for verifiable scientific literature metadata.",
      transport: "stdio",
      endpoint_url: null,
      command: runtime.command,
      args: runtime.args,
      socket_path: null,
      runtime_config: { lifecycle: "lazy", expose_resources: false, include_tools: [], exclude_tools: [], environment: {}, headers: {}, auth: "none", allow_private: false, terms_url: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/", privacy_url: "https://www.nlm.nih.gov/web_policies.html" },
      credential_ref: null,
    },
    tools: [
      { name: "search_pubmed", title: "Search PubMed", description: "Search PubMed for biomedical literature metadata.", read_only: true, decision: "ask" },
      { name: "search_arxiv", title: "Search arXiv", description: "Search arXiv for scientific preprints and metadata.", read_only: true, decision: "ask" },
      { name: "search_crossref", title: "Search Crossref", description: "Search Crossref for scholarly works and DOI metadata.", read_only: true, decision: "ask" },
    ],
  }];
}

function paperSearchRuntime(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, "builtin", "paper-search-server.js");
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  // Source-mode servers run through tsx; use its CLI so the spawned MCP child
  // can execute the TypeScript entrypoint without depending on a user Python.
  const source = resolve(here, "builtin", "paper-search-server.ts");
  const tsx = process.env.PI_TSX_PATH ?? resolve(here, "../../node_modules/.bin/tsx");
  return existsSync(source) ? { command: tsx, args: [source] } : { command: process.execPath, args: [compiled] };
}
