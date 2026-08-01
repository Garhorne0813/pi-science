import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultStyleMode, isSmilesFile, looksLikeMacromolecule, moleculeFormatFor, smilesToMolblock } from "./molecule";

const LYSOZYME = "../demos/molecular-playground/data/1LYS.pdb";

describe("molecule helpers", () => {
  it("maps molecule extensions to 3Dmol formats", () => {
    expect(moleculeFormatFor("aspirin.xyz")).toBe("xyz");
    expect(moleculeFormatFor("ligand.MOL")).toBe("sdf");
    expect(moleculeFormatFor("notes.txt")).toBeNull();
    expect(isSmilesFile("library.smiles")).toBe(true);
  });

  it("reads a real PDB fixture and applies the macromolecule heuristic", async () => {
    const pdb = await readFile(LYSOZYME, "utf8");
    expect(pdb).toContain("HEADER");
    // The bundled demo is deliberately truncated to seven residues, below the
    // large-structure threshold; secondary-structure records still trigger it.
    expect(looksLikeMacromolecule(pdb)).toBe(false);
    expect(defaultStyleMode("1LYS.pdb", pdb)).toBe("stick");
    expect(defaultStyleMode("protein.pdb", `HELIX    1\n${pdb}`)).toBe("cartoon");
    expect(defaultStyleMode("aspirin.xyz", "3\naspirin\nC 0 0 0")).toBe("stick");
  });

  it("converts valid SMILES records to an SDF while skipping invalid lines", async () => {
    const sdf = await smilesToMolblock(["# compounds", "CCO ethanol", "not-a-smiles broken", "O water"].join("\n"));
    expect(sdf).toContain("ethanol");
    expect(sdf).toContain("water");
    expect(sdf?.match(/\$\$\$\$/g)).toHaveLength(2);
    expect(await smilesToMolblock("# comments only")).toBeNull();
  });
});
