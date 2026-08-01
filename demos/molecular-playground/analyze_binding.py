#!/usr/bin/env python3
"""Analyze lysozyme structure — secondary structure and binding pocket."""

from pathlib import Path


def analyze_pdb(filepath=None):
    path = Path(filepath) if filepath else Path(__file__).parent / "data" / "1LYS.pdb"
    residues = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("ATOM") and line[12:16].strip() == "CA":
                fields = line.split()
                resn = fields[3]
                residues[resn] = residues.get(resn, 0) + 1

    print("🧬 Lysozyme Structure Analysis")
    print("=" * 40)
    print(f"Total residues (CA atoms): {len(residues)}")
    print()

    helix_prone = {"ALA", "LEU", "MET", "GLU", "LYS", "ARG", "HIS"}
    sheet_prone = {"VAL", "ILE", "TYR", "PHE", "TRP", "THR"}
    coil_prone = {"GLY", "PRO", "SER", "ASN", "ASP", "CYS", "GLN"}

    helix = sum(residues.get(residue, 0) for residue in helix_prone)
    sheet = sum(residues.get(residue, 0) for residue in sheet_prone)
    coil = sum(residues.get(residue, 0) for residue in coil_prone)

    print("Estimated Secondary Structure (by residue propensity):")
    print(f"  α-helix prone:  {helix} residues ({helix * 100 / len(residues):.0f}%)")
    print(f"  β-sheet prone:  {sheet} residues ({sheet * 100 / len(residues):.0f}%)")
    print(f"  Coil/turn:      {coil} residues ({coil * 100 / len(residues):.0f}%)")
    print()

    active_site = {"GLU", "ASP", "HIS", "SER", "CYS"}
    active = sum(residues.get(residue, 0) for residue in active_site)
    print(f"Catalytic residues (E/D/H/S/C): {active}")
    print("  (Lysozyme's catalytic dyad: Glu35 + Asp52)")


if __name__ == "__main__":
    analyze_pdb()
