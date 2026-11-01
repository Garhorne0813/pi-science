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

  it("leaves an ordinary link's own text exactly as written", () => {
    const tree: Node = { type: "paragraph", children: [{ type: "link", url: "https://example.org", children: [{ type: "text", value: "the 10.1000/linked paper" }] }] };
    (remarkCitations() as (tree: Node) => void)(tree);
    expect(tree.children).toEqual([{ type: "link", url: "https://example.org", children: [{ type: "text", value: "the 10.1000/linked paper" }] }]);
  });

  it("tags a link that points at a DOI resolver without rewriting its text", () => {
    const tree: Node = { type: "paragraph", children: [{ type: "link", url: "https://doi.org/10.1000/linked", children: [{ type: "text", value: "doi:10.1000/linked" }] }] };
    (remarkCitations() as (tree: Node) => void)(tree);
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0]!.children).toEqual([{ type: "text", value: "doi:10.1000/linked" }]);
    expect((tree.children![0]!.data!.hProperties as { dataCitation: string }).dataCitation).toBe("doi:10.1000/linked");
  });

  it("keeps the words of an ordinary link that points at a paper", () => {
    const tree: Node = { type: "paragraph", children: [{ type: "link", url: "https://arxiv.org/abs/2401.12345v2", children: [{ type: "text", value: "the 论文 we discussed" }] }] };
    (remarkCitations() as (tree: Node) => void)(tree);
    expect(tree.children![0]!.children).toEqual([{ type: "text", value: "the 论文 we discussed" }]);
    expect((tree.children![0]!.data!.hProperties as { dataCitation: string }).dataCitation).toBe("arxiv:2401.12345v2");
  });

  it("leaves fenced code, inline code and math alone", () => {
    const tree: Node = {
      type: "root",
      children: [
        { type: "code", value: "curl https://doi.org/10.1000/fenced" },
        { type: "paragraph", children: [{ type: "inlineCode", value: "10.1000/inline" }] },
        { type: "math", value: "10.1000/math" },
        { type: "paragraph", children: [{ type: "text", value: "but 10.1000/prose is a citation" }] },
      ],
    };
    (remarkCitations() as (tree: Node) => void)(tree);
    expect(tree.children![0]).toEqual({ type: "code", value: "curl https://doi.org/10.1000/fenced" });
    expect(tree.children![1]!.children).toEqual([{ type: "inlineCode", value: "10.1000/inline" }]);
    expect(tree.children![2]).toEqual({ type: "math", value: "10.1000/math" });
    expect(tree.children![3]!.children!.some((node) => node.type === "link")).toBe(true);
  });

  it("does not swallow a numbered marker that follows the identifier", () => {
    const nodes = run("Gain on QA (10.1000/alpha)[1].");
    const link = nodes.find((node) => node.type === "link");
    expect(link).toMatchObject({ url: "https://doi.org/10.1000/alpha" });
    expect((link!.data!.hProperties as { dataCitation: string }).dataCitation).toBe("doi:10.1000/alpha");
    expect(link!.children![0]!.value).toBe("10.1000/alpha");
    expect(nodes.map((node) => node.value ?? "").join("")).toContain("[1]");
  });

  it("takes the doi: scheme into the link so it cannot be left in the prose", () => {
    const nodes = run("The DOI is doi:10.1038/s41586-021-03819-2 here.");
    const link = nodes.find((node) => node.type === "link");
    expect(link).toMatchObject({ url: "https://doi.org/10.1038/s41586-021-03819-2" });
    expect(link!.children![0]!.value).toBe("doi:10.1038/s41586-021-03819-2");
    expect(nodes.map((node) => node.value ?? "").join("")).toBe("The DOI is  here.");
  });

  it("takes the scheme in any case, with spaces, and next to Chinese text", () => {
    const nodes = run("见doi:10.1000/a，另见 DOI : 10.1000/b。");
    const links = nodes.filter((node) => node.type === "link");
    expect(links.map((node) => node.children![0]!.value)).toEqual(["doi:10.1000/a", "DOI : 10.1000/b"]);
    expect(nodes.map((node) => node.value ?? "").join("")).toBe("见，另见 。");
  });

  it("leaves a word that merely ends in doi attached to the prose", () => {
    const nodes = run("xdoi:10.1000/a");
    const texts = nodes.filter((node) => node.type === "text").map((node) => node.value ?? "").join("");
    expect(texts).toBe("xdoi:");
    expect(nodes.find((node) => node.type === "link")!.children![0]!.value).toBe("10.1000/a");
  });

  it("keeps a meaningful link's own words instead of rewriting them", () => {
    const tree: Node = { type: "paragraph", children: [{ type: "link", url: "https://doi.org/10.1000/a", children: [{ type: "text", value: "论文 doi:10.1000/a 的方法" }] }, { type: "text", value: " and doi:10.1000/b" }] };
    (remarkCitations() as (tree: Node) => void)(tree);
    expect(tree.children![0]!.children).toEqual([{ type: "text", value: "论文 doi:10.1000/a 的方法" }]);
    expect(tree.children![2]!.children![0]!.value).toBe("doi:10.1000/b");
  });
});
