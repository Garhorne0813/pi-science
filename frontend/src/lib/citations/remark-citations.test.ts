import { describe, expect, it } from "vitest";
import { remarkCitations } from "./remark-citations";

type Node = { type?: string; value?: string; url?: string; children?: Node[]; data?: { hProperties?: Record<string, unknown> } };

function run(text: string): Node[] {
  const tree: Node = { type: "paragraph", children: [{ type: "text", value: text }] };
  (remarkCitations() as (tree: Node) => void)(tree);
  return tree.children ?? [];
}

describe("remarkCitations", () => {
  it("wraps bare DOIs while preserving their text exactly", () => {
    const nodes = run("Prior work (10.1038/s41586-025-10072-4) shows this.");
    const link = nodes.find((node) => node.type === "link");
    expect(link).toMatchObject({ url: "https://doi.org/10.1038/s41586-025-10072-4" });
    expect(link!.children![0]).toMatchObject({ value: "10.1038/s41586-025-10072-4" });
    expect(link!.data!.hProperties).toMatchObject({ dataCitation: "doi:10.1038/s41586-025-10072-4" });
  });

  it("wraps arXiv ids with the cited version", () => {
    const nodes = run("See arXiv:2401.12345v2 for details.");
    const link = nodes.find((node) => node.type === "link");
    expect(link).toMatchObject({ url: "https://arxiv.org/abs/2401.12345v2" });
    expect(link!.data!.hProperties).toMatchObject({ dataCitation: "arxiv:2401.12345v2" });
  });

  it("keeps the cited arXiv version in the request key and the link", () => {
    const nodes = run("See arXiv:2401.12345v2 and arXiv:2401.12345v1.");
    const links = nodes.filter((node) => node.type === "link");
    expect(links.map((node) => node.url)).toEqual(["https://arxiv.org/abs/2401.12345v2", "https://arxiv.org/abs/2401.12345v1"]);
    // The evidence lookup reports whether the snapshot describes the version
    // the answer cites, so the request key carries the version while the
    // visible text stays exactly what the model wrote.
    expect(links.map((node) => (node.data!.hProperties as { dataCitation: string }).dataCitation)).toEqual(["arxiv:2401.12345v2", "arxiv:2401.12345v1"]);
    expect(links.map((node) => node.children![0]!.value)).toEqual(["arXiv:2401.12345v2", "arXiv:2401.12345v1"]);
  });

  it("keeps surrounding prose intact", () => {
    const nodes = run("Before 10.1/none-matching here after.");
    expect(nodes.every((node) => node.type === "text")).toBe(true);
    expect(nodes.map((node) => node.value ?? "").join("")).toBe("Before 10.1/none-matching here after.");
  });

  it("handles multiple citations in one text run", () => {
    const nodes = run("A 10.1234/first and arXiv:2506.00001 together.");
    const links = nodes.filter((node) => node.type === "link");
    expect(links).toHaveLength(2);
    const text = nodes.filter((node) => node.type === "text").map((node) => node.value ?? "").join("");
    expect(text).toContain("A ");
    expect(text).toContain(" and ");
    expect(text).toContain(" together.");
  });

  it("descends into nested structures like list items", () => {
    const tree: Node = { type: "list", children: [{ type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "cite 10.5555/nested." }] }] }] };
    (remarkCitations() as (tree: Node) => void)(tree);
    const paragraph = tree.children![0]!.children![0]!;
    expect(paragraph.children!.some((node) => node.type === "link")).toBe(true);
  });

  it("terminates DOI links at CJK text and fullwidth punctuation", () => {
    const nodes = run("AlphaFold 方法见 10.1038/s41586-021-03819-2，另见 arXiv:2112.10752。");
    const link = nodes.find((node) => node.type === "link");
    expect(link).toMatchObject({ url: "https://doi.org/10.1038/s41586-021-03819-2" });
    const arxivLink = nodes.filter((node) => node.type === "link")[1];
    expect(arxivLink).toMatchObject({ url: "https://arxiv.org/abs/2112.10752" });
    expect(nodes.map((node) => node.value ?? "").join("")).toContain("，另见");
  });
});
