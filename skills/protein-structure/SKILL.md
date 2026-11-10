---
name: protein-structure
description: Predict and inspect 3D protein structures from amino-acid sequences. Use when the user provides a protein sequence (or a gene/protein identifier to fetch one) and wants a predicted structure, wants to compare wild-type and mutant structures, or wants to visualize and measure an existing PDB/CIF/mmCIF file. Guides sequence fetching (UniProt), structure prediction with ESMFold or ColabFold locally in the session kernel (or through a user-configured endpoint such as a BioNeMo NIM server), and pLDDT-quality reporting; results are saved as PDB files so the built-in Mol* viewer can render them.
version: 0.1.0
license: Apache-2.0
category: structural-biology
requirements:
  - python
risk: medium
third_party:
  - kind: library
    name: ESM / ESMFold (MIT License, model weights EMC-community license)
    provider: Meta AI Research
    license: MIT
    info_url: https://github.com/facebookresearch/esm
  - kind: library
    name: ColabFold (Apache-2.0 / ColabFold community)
    provider: ColabFold community (Sergey Ovchinnikov, Martin Steinegger)
    license: Apache-2.0
    info_url: https://github.com/sokrypton/ColabFold
---

# Protein structure prediction and inspection

Turn an amino-acid sequence into a predicted 3D structure (saved as `.pdb` in
the workspace so the built-in Mol* viewer can render it), then report quality
honestly. Never fabricate a structure or a confidence number.

## Workflow

1. **Get the sequence.** If the user gives an identifier instead of a sequence,
   fetch the FASTA from UniProt (`https://rest.uniprot.org/uniprotkb/{id}.fasta`)
   using the normal web tools, and say which accession you used.
2. **Choose a prediction path** — ask the user when unclear which applies:
   - **Local ESMFold** (no MSA, fastest to set up, good for single chains).
     In a Python session kernel:
     ```python
     import torch, esm
     model = esm.pretrained.esmfold_v1()
     model.set_chunk_size(64)
     if torch.cuda.is_available(): model = model.cuda()
     sequence = "MKT..."  # the fetched sequence
     output = model.infer_pdb(sequence)
     open("structures/predicted.pdb", "w").write(output)
     ```
     Install first when the environment lacks it:
     `pip install "esm@git+https://github.com/facebookresearch/esm.git"`.
     ESMFold weights are ~2.8 GB; warn the user before the first download and
     prefer a GPU (`torch.cuda.is_available()`); CPU inference is very slow
     for sequences beyond ~300 residues.
   - **Local ColabFold** (MSA-based, higher accuracy for hard targets):
     `colabfold_batch query.fasta structures/` after
     `pip install colabfold[colabfold]` — needs local MMseqs2 for the MSA step.
   - **User-configured endpoint** (no local GPU needed). If the user has an
     inference server (for example a BioNeMo NIM or other OpenFold/Boltz
     endpoint), ask for its URL and use its documented API; never send
     sequences to an endpoint the user has not named.
3. **Report quality with the structure.** After predicting, parse the B-factor
   column (pLDDT) and summarize: mean pLDDT and the fraction of residues above
   70 and above 90. State plainly when a region is low-confidence rather than
   describing it as structured.
4. **Save and surface the result.** Write the PDB to the workspace
   (`structures/<name>.pdb`) so the user can open it in the structure viewer;
   for wild-type/mutant comparisons, save both files and describe the changed
   region with residue numbers and both local confidence values.

## Constraints

- Never invent coordinates, pLDDT values, or UniProt accessions; every number
  you report must come from the files you wrote or the API you called.
- Long runs and large downloads belong in the execution budget: state the
  expected cost (weight download, GPU time) before starting.
- If no prediction path is available (no GPU, no endpoint, no user choice),
  say so and stop — do not fall back to fabricating or sketching a structure.
