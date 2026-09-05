import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  arxivSearchInput,
  crossrefSearchInput,
  pubmedSearchInput,
  searchArxiv,
  searchCrossref,
  searchPubmed,
  type SearchEnvelope,
} from "./paper-search.js";

const server = new McpServer({ name: "pi-science-paper-search", version: "1.1.0" });

server.registerTool("search_crossref", {
  title: "Search Crossref",
  description: "Search Crossref scholarly metadata. Supports fielded queries, publication-date and work-type filters, sorting, and pagination.",
  inputSchema: crossrefSearchInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async (input) => result(await searchCrossref(input)));

server.registerTool("search_pubmed", {
  title: "Search PubMed",
  description: "Search PubMed article metadata. Supports field restriction, relevance or publication-date sorting, date filters, and pagination.",
  inputSchema: pubmedSearchInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async (input) => result(await searchPubmed(input)));

server.registerTool("search_arxiv", {
  title: "Search arXiv",
  description: "Search arXiv preprints. Supports field/category restriction, native arXiv query syntax, relevance/date sorting, IDs, and pagination.",
  inputSchema: arxivSearchInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async (input) => result(await searchArxiv(input)));

await server.connect(new StdioServerTransport());

function result(envelope: SearchEnvelope) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}
