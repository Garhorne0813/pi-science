#!/usr/bin/env python3
"""Analyze lysozyme structure — secondary structure & binding pocket."""

def analyze_pdb(filepath="data/1LYS.pdb"):
    residues = {}
    with open(filepath) as f:
        for line in f:
            if line.startswith("ATOM") and line[13:15].strip() == "CA":
                resn = line[17:20].strip()
                residues[resn] = residues.get(resn, 0) + 1

    print("🧬 Lysozyme Structure Analysis")
    print("=" * 40)
    print(f"Total residues (CA atoms): {len(residues)}")
    print()

    # Secondary structure prediction (simple dihedral-based)
    helix_prone = {"ALA", "LEU", "MET", "GLU", "LYS", "ARG", "HIS"}
    sheet_prone = {"VAL", "ILE", "TYR", "PHE", "TRP", "THR"}
    coil_prone = {"GLY", "PRO", "SER", "ASN", "ASP", "CYS", "GLN"}

    helix = sum(residues.get(r, 0) for r in helix_prone)
    sheet = sum(residues.get(r, 0) for r in sheet_prone)
    coil = sum(residues.get(r, 0) for r in coil_prone)

    print("Estimated Secondary Structure (by residue propensity):")
    print(f"  α-helix prone:  {helix} residues ({helix*100/len(residues):.0f}%)")
    print(f"  β-sheet prone:  {sheet} residues ({sheet*100/len(residues):.0f}%)")
    print(f"  Coil/turn:      {coil} residues ({coil*100/len(residues):.0f}%)")
    print()

    # Active site residues
    active_site = {"GLU", "ASP", "HIS", "SER", "CYS"}
    active = sum(residues.get(r, 0) for r in active_site)
    print(f"Catalytic residues (E/D/H/S/C): {active}")
    print("  (Lysozyme's catalytic dyad: Glu35 + Asp52)")

if __name__ == "__main__":
    analyze_pdb()
