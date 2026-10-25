// Remark plugin: turn bare DOI and arXiv identifiers in prose into citation
// links so the renderer can attach verified-evidence hovers. The visible text
// is preserved exactly; only the wrapping element changes.
const DOI_PATTERN = /10\.\d{4,9}\/[^\s)\]}>]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const TRAILING = /[.,;:!?*"']+$/;

type MdNode = { type?: string; value?: string; url?: string; children?: MdNode[]; data?: { hProperties?: Record<string, unknown> } };

/** Match rule-compatible extraction with lib/citations (frontend). */
export function remarkCitations() {
  const walk = (nodes: MdNode[], parent?: MdNode) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if (node.type === "text" && parent && typeof node.value === "string") {
        const value = node.value;
        const matches: Array<{ start: number; end: number; id: string; kind: "doi" | "arxiv"; url: string; label: string }> = [];
        for (const pattern of [DOI_PATTERN, ARXIV_PATTERN]) {
          for (const match of value.matchAll(pattern)) {
            const raw = match[0];
            const cleaned = raw.replace(TRAILING, "");
            if (pattern === DOI_PATTERN && cleaned.endsWith("/")) continue;
            const id = pattern === DOI_PATTERN ? cleaned.toLowerCase() : (match[1] ?? "").replace(/v\d+$/, "");
            if (!id) continue;
            matches.push({
              start: match.index ?? 0,
              end: (match.index ?? 0) + cleaned.length,
              id,
              kind: pattern === DOI_PATTERN ? "doi" : "arxiv",
              url: pattern === DOI_PATTERN ? `https://doi.org/${cleaned}` : `https://arxiv.org/abs/${id}`,
              label: cleaned,
            });
          }
        }
        if (!matches.length) continue;
        matches.sort((left, right) => left.start - right.start);
        const replacement: MdNode[] = [];
        let cursor = 0;
        for (const match of matches) {
          if (match.start < cursor) continue; // overlapping arXiv/DOI hits
          if (match.start > cursor) replacement.push({ type: "text", value: value.slice(cursor, match.start) });
          replacement.push({
            type: "link",
            url: match.url,
            children: [{ type: "text", value: match.label }],
            data: { hProperties: { className: ["citation-ref"], dataCitation: `${match.kind}:${match.id}` } },
          });
          cursor = match.end;
        }
        if (cursor < value.length) replacement.push({ type: "text", value: value.slice(cursor) });
        nodes.splice(index, 1, ...replacement);
        index += replacement.length - 1;
        continue;
      }
      if (Array.isArray(node.children)) walk(node.children, node);
    }
  };
  return (tree: MdNode) => { walk([tree]); };
}
