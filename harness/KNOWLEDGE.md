# Pi-Science Knowledge Base

## File Format Reference

### Scientific data formats
- **CSV/TSV**: Use pandas `read_csv()` / `read_table()`. Check encoding (UTF-8 vs Latin-1).
- **NetCDF/HDF5**: Use `h5py` or `xarray`. Check variable names with `.keys()`.
- **FITS**: Astronomy format. Use `astropy.io.fits`. Primary HDU at index 0.
- **Parquet**: Use `pandas.read_parquet()`.

### Plotting
- Use `matplotlib` with `Agg` backend (no display).
- Save figures with `plt.savefig("name.png", dpi=150, bbox_inches="tight")`.
- Prefer PNG for inline display; PDF for publications.

### Python environment
- Preferred package manager: `pip` (what the user has).
- Install packages with `pip install <name>`.
- For conda environments, use `conda install`.

## Common Workflows

### Data analysis
1. Read file header with `read` tool to understand structure
2. Write a Python script to load and explore data
3. Generate summary statistics and plots
4. Document findings in the conversation

### Remote computation
1. Check `.pi-science/compute.json` for available machines
2. Write the computation script locally
3. Use `run_remote` to execute on HPC/GPU
4. Fetch results back with `fetch_results`
