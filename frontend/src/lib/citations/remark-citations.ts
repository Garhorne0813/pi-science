// Remark plugin: turn bare DOI and arXiv identifiers in prose into citation
// links so the renderer can attach verified-evidence hovers. The visible text
// is preserved exactly; only the wrapping element changes. Text that is
// already something else keeps its meaning: a link's own text and code or math
// is left alone, because rewriting it would put a second link inside a link or
// turn an example into a citation. Code and math nodes carry `value`, not
// `text`, so only the link guard is needed here.
//
// An ordinary Markdown link that points at a DOI or arXiv resolver asserts the
// same source as a bare identifier, so it is tagged for a body number while its
// own text stays written. Without the tag the source list numbered a source the
// body gave no way to reach.
import { identifierFromUrl, identifierUrl, scanIdentifiers } from "@pi-science/contracts";

type MdNode = { type?: string; value?: string; url?: string; children?: MdNode[]; data?: { hProperties?: Record<string, unknown> } };

const LINK_TYPES = new Set(["link", "linkReference"]);

function tag(node: MdNode, citationKey: string): void {
  node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataCitation: citationKey } };
}

export function remarkCitations() {
  const walk = (nodes: MdNode[]) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if (node.type === "text" && typeof node.value === "string") {
        const value = node.value;
        const matches = scanIdentifiers(value);
        if (!matches.length) continue;
        const replacement: MdNode[] = [];
        let cursor = 0;
        for (const match of matches) {
          if (match.start < cursor) continue;
          // The label starts at the scheme, not at the identifier, so `doi:`
          // travels with the citation instead of being stranded in the prose.
          const labelStart = Math.max(match.label_start, cursor);
          if (labelStart > cursor) replacement.push({ type: "text", value: value.slice(cursor, labelStart) });
          const label = value.slice(labelStart, match.end);
          const link: MdNode = { type: "link", url: identifierUrl(match.kind, match.requested_id), children: [{ type: "text", value: label }] };
          tag(link, `${match.kind}:${match.requested_id}`);
          replacement.push(link);
          cursor = match.end;
        }
        if (cursor < value.length) replacement.push({ type: "text", value: value.slice(cursor) });
        nodes.splice(index, 1, ...replacement);
        index += replacement.length - 1;
        continue;
      }
      if (node.type && LINK_TYPES.has(node.type)) {
        const target = typeof node.url === "string" ? identifierFromUrl(node.url) : null;
        if (target) tag(node, `${target.kind}:${target.requested_id}`);
        continue;
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  return (tree: MdNode) => { walk([tree]); };
}
