import { describe, expect, it } from "vitest";
import { formatBp, genomeFormat, packRows, parseGenome } from "./genome";

const GFF3 = [
  "##gff-version 3",
  "chr1\tRefSeq\tgene\t100\t500\t.\t+\t.\tID=gene1;Name=BRCA1",
  "chr1\tRefSeq\texon\t150\t220\t8.5\t+\t.\tID=exon1;Parent=gene1",
  "chr2\tRefSeq\tgene\t10\t90\t.\t-\t.\tID=gene2;Name=TP53",
].join("\n");

describe("genome parsers", () => {
  it("recognizes supported track extensions", () => {
    expect(genomeFormat("GFF3")).toBe("gff");
    expect(genomeFormat("bdg")).toBe("bedgraph");
    expect(genomeFormat("fasta")).toBeNull();
  });

  it("parses a GFF3 sample and groups the busiest contig first", () => {
    const result = parseGenome(GFF3, "gff");
    expect(result.features).toHaveLength(3);
    expect(result.features[0]).toMatchObject({ chrom: "chr1", start: 100, end: 500, name: "BRCA1", strand: "+" });
    expect(result.features[1]).toMatchObject({ type: "exon", score: 8.5 });
    expect(result.contigs).toEqual([
      { name: "chr1", min: 100, max: 500, count: 2 },
      { name: "chr2", min: 10, max: 90, count: 1 },
    ]);
  });

  it("converts BED coordinates and packs overlapping features into separate rows", () => {
    const result = parseGenome(["chr1\t0\t10\ta", "chr1\t5\t15\tb", "chr1\t15\t20\tc"].join("\n"), "bed");
    expect(result.features.map(({ start, end }) => [start, end])).toEqual([[1, 10], [6, 15], [16, 20]]);
    expect(packRows(result.features)).toEqual([0, 1, 0]);
    expect(formatBp(1_500_000)).toBe("1.5M");
  });
});
