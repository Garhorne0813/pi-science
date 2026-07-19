# Scientific File Format Reference

## Tabular data
- **CSV/TSV**: Use pandas `read_csv()` / `read_table()`. Always check encoding
  (UTF-8 vs Latin-1) and delimiter before loading. Inspect the first few rows
  with `head()` before full analysis.
- **Parquet**: Use `pandas.read_parquet()`. Preferred for large tabular data —
  stores schema, compresses well, and loads faster than CSV.

## Multi-dimensional data
- **NetCDF / HDF5**: Use `xarray` (recommended) or `h5py`. Always check
  variable names and dimensions with `.keys()` or `.variables` before
  accessing. NetCDF files may have coordinate systems and units encoded in
  metadata — preserve these in any derived output.

## Astronomy
- **FITS**: Use `astropy.io.fits`. Primary HDU is at index 0. Check
  `.info()` for the HDU structure. Header carries WCS coordinates, exposure
  times, and instrument metadata — never strip these without recording them.

## Chemistry and structural biology
- **CIF**: Crystallographic Information File. Use `gemmi` or `pymatgen`.
- **PDB**: Protein Data Bank. Use `biopython.Bio.PDB` or 3Dmol.js for
  visualization. Check for alternate conformations and missing residues.
- **SDF / MOL**: Chemical structure files. Use RDKit (`Chem.SDMolSupplier`,
  `Chem.MolFromMolFile`) for parsing. Verify bond orders and stereochemistry.
- **SMILES**: Use RDKit (`Chem.MolFromSmiles`) or OpenChemLib. Always
  canonicalize before comparison. Check for parsing failures (returns `None`).
- **XYZ**: Simple coordinate format. Check atom count in line 1 matches the
  number of coordinate lines. Units are typically Ångströms.

## Solid-state physics
- **EIGENVAL**: VASP eigenvalue output. Contains k-point paths, band indices,
  and energy eigenvalues. Check the Fermi level convention before plotting.
- **DOSCAR**: VASP density of states. Contains spin channels and energy grids.
  Verify the energy zero (Fermi level) before interpretation.

## Genomics
- **BED**: Browser Extensible Data — genomic intervals. 0-based, half-open.
  Columns: chrom, start, end, [name, score, strand, …].
- **GFF / GTF**: Gene annotation formats. 1-based, inclusive. Check the
  attribute column (column 9) for gene IDs, transcript IDs, and functional
  annotations.
- **VCF**: Variant Call Format. Contains header metadata lines (##) followed
  by variant records. Check FORMAT and INFO fields for variant annotations.
- **FASTA / FASTQ**: Sequence data. FASTQ has quality scores (Phred scale).
  Use `biopython.SeqIO` for parsing.

## 3D / CAD
- **STL**: Stereolithography — triangular mesh. Binary or ASCII. No units
  embedded; assume mm unless specified.
- **OBJ**: Wavefront OBJ. Vertices, normals, texture coordinates, and faces.
  May reference an external .mtl material file.
- **PLY**: Polygon File Format. Binary or ASCII. Properties defined per
  element in the header.
- **glTF / GLB**: GL Transmission Format. JSON scene description + binary
  buffers. GLB is the single-file binary container.

## Documents
- **DOCX / XLSX / PPTX**: Office Open XML. Use `python-docx`, `openpyxl`, and
  `python-pptx` for programmatic access. The pi-science UI renders these
  natively.
