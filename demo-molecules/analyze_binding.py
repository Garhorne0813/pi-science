#!/usr/bin/env python3
"""Analyze lysozyme PDB — secondary structure prediction from residue propensity."""

def analyze(filepath="data/1LYS.pdb"):
    residues={}
    with open(filepath) as f:
        for line in f:
            if line.startswith("ATOM") and line[13:15].strip()=="CA":
                resn=line[17:20].strip()
                residues[resn]=residues.get(resn,0)+1

    helix={"ALA","LEU","MET","GLU","LYS","ARG","HIS"}
    sheet={"VAL","ILE","TYR","PHE","TRP","THR"}
    coil={"GLY","PRO","SER","ASN","ASP","CYS","GLN"}

    h=sum(residues.get(r,0) for r in helix)
    s=sum(residues.get(r,0) for r in sheet)
    c=sum(residues.get(r,0) for r in coil)

    print(f"Total CA atoms: {len(residues)}")
    print(f"Helix-prone: {h} ({h*100/len(residues):.0f}%)")
    print(f"Sheet-prone: {s} ({s*100/len(residues):.0f}%)")
    print(f"Coil/turn:   {c} ({c*100/len(residues):.0f}%)")
    print(f"Active site (E/D/H/S/C): {sum(residues.get(r,0) for r in {'GLU','ASP','HIS','SER','CYS'})}")

if __name__=="__main__":
    analyze()
