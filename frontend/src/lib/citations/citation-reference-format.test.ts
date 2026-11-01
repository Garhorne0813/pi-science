import { expect, it } from "vitest";
import { formattedReference, type CitationReferenceFields } from "./citation-reference-format";

const record: CitationReferenceFields = {
  kind: "doi", id: "10.1000/alpha", title: "A cited paper", authors: ["Ashish Vaswani", "Noam Shazeer"],
  journal: "JACS", year: "2017", volume: "12", issue: "3", pages: "100-110",
};

it("writes the record as a GB/T 7714 journal entry", () => {
  expect(formattedReference(record, "gbt7714")).toBe("Ashish Vaswani, Noam Shazeer. A cited paper[J]. JACS, 2017, 12(3), 100-110. DOI: 10.1000/alpha.");
});

it("writes the record as an APA entry with the initials the names carry", () => {
  expect(formattedReference(record, "apa")).toBe("Vaswani, A., & Shazeer, N. (2017). A cited paper. JACS, 12(3), 100-110. https://doi.org/10.1000/alpha");
});

it("leaves out every field the record does not carry instead of printing a placeholder", () => {
  const sparse: CitationReferenceFields = { kind: "doi", id: "10.1000/alpha", title: "A cited paper", authors: [], journal: null, year: null, volume: null, issue: null, pages: null };
  expect(formattedReference(sparse, "gbt7714")).toBe("A cited paper[EB/OL]. DOI: 10.1000/alpha.");
  expect(formattedReference(sparse, "apa")).toBe("A cited paper. https://doi.org/10.1000/alpha");
});

it("keeps a volume without an issue and an issue without a volume as they are", () => {
  expect(formattedReference({ ...record, issue: null }, "apa")).toContain("JACS, 12, 100-110.");
  expect(formattedReference({ ...record, volume: null }, "apa")).toContain("JACS, 3, 100-110.");
});

it("marks an arXiv record as an online resource and locates it by its own URL", () => {
  const preprint: CitationReferenceFields = { ...record, kind: "arxiv", id: "2401.12345", journal: null, year: null, volume: null, issue: null, pages: null };
  expect(formattedReference(preprint, "gbt7714")).toBe("Ashish Vaswani, Noam Shazeer. A cited paper[EB/OL]. https://arxiv.org/abs/2401.12345.");
  expect(formattedReference(preprint, "apa")).toBe("Vaswani, A., & Shazeer, N. A cited paper. https://arxiv.org/abs/2401.12345");
});

it("has nothing to format when the record holds only its identifier", () => {
  const bare: CitationReferenceFields = { kind: "doi", id: "10.1000/alpha", title: null, authors: [], journal: null, year: null, volume: null, issue: null, pages: null };
  expect(formattedReference(bare, "gbt7714")).toBeNull();
  expect(formattedReference(bare, "apa")).toBeNull();
});

it("lists three authors and names the rest as et al in GB/T 7714", () => {
  expect(formattedReference({ ...record, authors: ["A One", "B Two", "C Three", "D Four"] }, "gbt7714")).toContain("A One, B Two, C Three, et al.");
});
