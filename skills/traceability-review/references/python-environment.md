# Python Environment

## Package management
- Preferred package manager: `pip` (what the user is most likely to have).
- Install packages with `pip install <name>`. For conda environments, use
  `conda install` or `mamba install`.
- Record exact versions when reproducibility matters:
  ```bash
  pip freeze | grep -E "numpy|scipy|pandas|matplotlib|astropy|rdkit|biopython|xarray"
  ```
- The pi-science platform can capture a full `pip freeze` snapshot on request
  via the provenance system.

## Core scientific stack
| Domain | Libraries |
|--------|-----------|
| General | numpy, scipy, pandas |
| Visualization | matplotlib, seaborn |
| Astronomy | astropy, astroquery |
| Chemistry | rdkit, openchemlib |
| Structural biology | biopython, gemmi |
| Solid-state physics | pymatgen, ase |
| Genomics | biopython, pysam, pyvcf |
| Statistics | scipy.stats, statsmodels, scikit-learn |
| Multi-dimensional | xarray, h5py, netCDF4 |
| Document processing | python-docx, openpyxl, python-pptx, pypdf |

## Common workflows

### Data analysis
1. Read the file header with the `read` tool to understand structure and size.
2. Write a Python script (not a one-liner) to load and explore the data.
3. Check for missing values, outliers, and data type issues before analysis.
4. Generate summary statistics first, then plots, then interpretation.
5. Document findings in the conversation; save key outputs as workspace files.

### Figure generation
1. Identify the claim, the data columns, the unit, and the comparison.
2. Choose a chart type that matches the data shape (see `visualization.md`).
3. Apply the publication palette. Use `bbox_inches="tight"` when saving.
4. Verify the saved image: readable, non-empty, correctly labeled, not clipped.

### Remote computation
1. Check `.pi-science/compute.json` for available machines (SSH servers, GPU
   boxes, Slurm clusters).
2. Write and test the computation script locally on a small subset first.
3. Use the `remote-compute` skill to dispatch the job.
4. Fetch results back and verify they match local test output.
