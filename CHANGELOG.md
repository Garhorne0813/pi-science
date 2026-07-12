# Changelog

All notable changes to Pi-Science will be documented in this file.

## [0.1.0] - 2026-07-11

### Added
- **Agent Chat**: Real-time streaming conversation with any LLM provider supported by pi (25+ providers)
- **Session Management**: Create, list, resume, and delete agent sessions with fork/branch history
- **SSE Streaming**: Server-Sent Events for real-time agent responses and tool execution visualization
- **Scientific File Viewers** (15+ formats):
  - FITS astronomy images with color maps (magma, viridis, gray)
  - 3D molecular structures (CIF, PDB, SDF, MOL, SMILES, XYZ) via 3Dmol.js
  - 3D mesh/CAD models (STL, OBJ, PLY, glTF, GLB) via Three.js
  - VASP band structures (EIGENVAL) and density of states (DOSCAR)
  - Phase diagrams with convex hull analysis
  - Genome annotation tracks (BED, GFF, GTF, VCF)
  - CSV/TSV tables with SVG charting (line, bar, scatter)
  - Office documents (DOCX, XLSX, PPTX)
  - QCode qualitative coding and anomaly maps
  - PDF, images, video, Markdown, and syntax-highlighted code
- **Python/R Kernels**: Execute code in persistent, isolated kernel sessions per notebook
- **Notebook Panel**: Interactive cell-based interface with Python/R support
- **Provenance Tracking**: Append-only JSONL recording every file write/edit with version history and content hashing
- **Automatic Provenance**: write/edit tool completions auto-record provenance entries
- **File Browser**: Sidebar workspace file listing with click-to-preview
- **Status Bar**: Live health monitoring of pi processes and kernel sessions
- **Dark/Light Theme**: CSS custom property-based theming system
- **Internationalization**: English (en) and Simplified Chinese (zh-Hans) support
- **Python Package**: pip-installable backend with `pi-science` CLI command
- **FastAPI Backend**: REST API with 22 endpoints and interactive OpenAPI docs
- **React Frontend**: Vite + TypeScript + Tailwind CSS with Zustand state management

### Technical Stack
- **Backend**: Python 3.12, FastAPI, Uvicorn, Pydantic, sse-starlette
- **Frontend**: React 18, TypeScript 5.6, Vite 5, Tailwind CSS 3, Zustand 5, React Router 6
- **Agent Runtime**: pi (Node.js, RPC mode via JSONL over stdin/stdout)
- **3D Graphics**: Three.js, 3Dmol.js
- **Chemistry**: OpenChemLib
- **Document Rendering**: docx-preview, ExcelJS, pptx-preview
- **Code Highlighting**: highlight.js

## [Unreleased]

### Planned for 0.2.0
- Remote compute via SSH/Slurm job submission
- Experiment run tracking with runs.jsonl
- Multi-session orchestration with shared workspace
- Task templates for common scientific workflows
- Advanced provenance query interface
- Jupyter notebook (.ipynb) import/export
- Docker and Kubernetes deployment templates
- Comprehensive test suite
