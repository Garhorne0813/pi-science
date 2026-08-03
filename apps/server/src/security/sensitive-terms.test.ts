import { afterEach, describe, expect, it } from "vitest";
import { detectSensitiveTerms } from "./sensitive-terms.js";

const originalEnv = process.env.PI_SCIENCE_SENSITIVE_TERMS;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.PI_SCIENCE_SENSITIVE_TERMS;
  else process.env.PI_SCIENCE_SENSITIVE_TERMS = originalEnv;
});

describe("detectSensitiveTerms", () => {
  it("returns matched=false for an ordinary scientific query", () => {
    const result = detectSensitiveTerms("band structure of silicon carbide under pressure");
    expect(result.matched).toBe(false);
    expect(result.categories).toEqual([]);
  });

  describe("dna-sequence", () => {
    it("flags long nucleotide runs", () => {
      const result = detectSensitiveTerms("sequence ACGTACGTACGTACGTACGT found in sample");
      expect(result.categories).toContain("dna-sequence");
      expect(result.terms[0]).toBe("ACGTACGTACGTACGTACGT");
    });

    it("does not flag short or prose words", () => {
      expect(detectSensitiveTerms("the ACG motif").matched).toBe(false);
      expect(detectSensitiveTerms("mathematical notation").matched).toBe(false);
    });
  });

  describe("protein-sequence", () => {
    it("flags long amino-acid runs with low-frequency letters", () => {
      const result = detectSensitiveTerms("peptide MYKGHCFWYTPVQN was assayed");
      expect(result.categories).toContain("protein-sequence");
    });

    it("does not flag English words or runs without low-frequency letters", () => {
      expect(detectSensitiveTerms("internationalization process").matched).toBe(false);
      expect(detectSensitiveTerms("ADEGIKLNPQRS").matched).toBe(false); // 12 letters, no low-frequency letters
    });

    it("does not flag rare long English words on the exclude list (case-insensitive)", () => {
      expect(detectSensitiveTerms("characteristically correct").matched).toBe(false);
      expect(detectSensitiveTerms("CHARACTERISTICS of the dataset").matched).toBe(false);
      expect(detectSensitiveTerms("mathematically equivalent").matched).toBe(false);
      expect(detectSensitiveTerms("characteristic length").matched).toBe(false);
    });

    it("is case-insensitive", () => {
      const result = detectSensitiveTerms("mykghcfwytpvqnl");
      expect(result.categories).toContain("protein-sequence");
    });
  });

  describe("compound-identifier", () => {
    it("flags SMILES ion forms, ring closures and InChI", () => {
      expect(detectSensitiveTerms("sodium [Na+] and [Cl-] ions").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("structure C1CCCCC1").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("InChI=1S/C2H6O/c1-2-3/h3H,2H2,1H3").categories).toContain("compound-identifier");
    });

    it("flags chain-style SMILES without ring closure", () => {
      expect(detectSensitiveTerms("ethanol is CCO").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("acetic acid CC(=O)O").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("benzene C1=CC=CC=C1").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("carbon dioxide O=C=O").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("the ring c1ccccc1 was derivatized").categories).toContain("compound-identifier");
    });

    it("does not flag plain text", () => {
      expect(detectSensitiveTerms("the catalyst was dissolved in ethanol").matched).toBe(false);
    });

    it("does not flag manuscript placeholders or e2e/b2b shorthands", () => {
      expect(detectSensitiveTerms("the [A] group was substituted with [B]").matched).toBe(false);
      expect(detectSensitiveTerms("e2e tests and b2b flows passed").matched).toBe(false);
    });

    it("does not flag code-style tokens, single-atom brackets, formula shorthands or hyphenated prose", () => {
      expect(detectSensitiveTerms("R2D2 and C3PO are characters").matched).toBe(false);
      expect(detectSensitiveTerms("the [C] atom and [N] position").matched).toBe(false);
      expect(detectSensitiveTerms("CO2 levels, CH4 emissions and H2O vapor").matched).toBe(false);
      expect(detectSensitiveTerms("the CC-BY 4.0 license applies").matched).toBe(false);
    });

    it("does not flag slash-enumerated prose lists", () => {
      expect(detectSensitiveTerms("CO2/CH4/H2O ratios were measured").matched).toBe(false);
      expect(detectSensitiveTerms("CNN/BBC coverage was cited").matched).toBe(false);
      expect(detectSensitiveTerms("pH/temp profiles were recorded").matched).toBe(false);
    });

    it("still flags chain-style SMILES after the slash-gate change", () => {
      expect(detectSensitiveTerms("ethanol is CCO").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("acetic acid CC(=O)O").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("benzene C1=CC=CC=C1").categories).toContain("compound-identifier");
      expect(detectSensitiveTerms("amide N[C@@H](C)C(=O)O").categories).toContain("compound-identifier");
    });
  });

  describe("clinical-identifier", () => {
    it("flags labeled record numbers", () => {
      expect(detectSensitiveTerms("patient ID 88421301").categories).toContain("clinical-identifier");
      expect(detectSensitiveTerms("病历号：2024001234").categories).toContain("clinical-identifier");
      expect(detectSensitiveTerms("MRN 55881").categories).toContain("clinical-identifier");
    });

    it("does not flag bare digit sequences", () => {
      expect(detectSensitiveTerms("the order 2024001234567890 was shipped").matched).toBe(false);
    });

    it("does not flag bare alphanumeric strings after patient (label required)", () => {
      expect(detectSensitiveTerms("patient 88AB123 admitted").matched).toBe(false);
    });

    it("does not flag plain prose mentioning patients", () => {
      expect(detectSensitiveTerms("patient satisfaction survey results 2024").matched).toBe(false);
      expect(detectSensitiveTerms("patients reported improved outcomes").matched).toBe(false);
    });

    it("flags a bare digit run directly after patient", () => {
      const result = detectSensitiveTerms("patient 88421301 admitted");
      expect(result.categories).toContain("clinical-identifier");
    });
  });

  describe("custom", () => {
    it("flags configured terms (case-insensitive substring)", () => {
      const result = detectSensitiveTerms("results for Project Pulsar-9 final", { customTerms: ["pulsar-9"] });
      expect(result.categories).toContain("custom");
      expect(result.terms).toContain("pulsar-9");
    });

    it("ignores single-character terms", () => {
      expect(detectSensitiveTerms("alpha beta gamma", { customTerms: ["a"] }).matched).toBe(false);
    });

    it("reads the term list from PI_SCIENCE_SENSITIVE_TERMS env", () => {
      process.env.PI_SCIENCE_SENSITIVE_TERMS = "北极星计划, codename-heron";
      const result = detectSensitiveTerms("部署 codename-heron 的相关数据");
      expect(result.categories).toContain("custom");
      expect(result.terms).toContain("codename-heron");
    });
  });

  it("reports every category that matches", () => {
    const result = detectSensitiveTerms("ACGTACGTACGTACGT and patient ID 77122301 with InChI=1S/C2H6O");
    expect(result.matched).toBe(true);
    expect(result.categories.sort()).toEqual(["clinical-identifier", "compound-identifier", "dna-sequence"]);
  });

  it("clips very long hits", () => {
    const result = detectSensitiveTerms(` ${"ACGT".repeat(200)} `);
    expect(result.terms[0]!.length).toBeLessThanOrEqual(121);
  });
});
