# Pi-Science

**Scientific AI Workbench**

Pi-Science is a web-native workbench where scientists converse with AI agents to explore data, write analysis code, visualize results, and track artifact lineage in one browser-based workspace.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Features

- **Agent chat** — streaming responses, tool-call cards, Markdown/LaTeX rendering, session create/resume/fork/delete, slash commands, interactive prompts, and resilient SSE reconnects.
- **Project Knowledge Reviewer** — proposal-only review, evidence links, human approval, versioned `PROJECT.md`, safe file plans, transactional moves, undo, and per-project policy.
- **Scientific viewers** — native browser viewers for FITS, CIF, PDB, SDF, MOL, SMILES, XYZ, STL, OBJ, PLY, glTF, EIGENVAL, DOSCAR, phase data, genomics formats, CSV/TSV, DOCX/XLSX/PPTX, code, images, PDF, and video.
- **Provenance** — every agent-created or edited file records the tool, model, code/diff, environment snapshot, reproduce prompt, and originating conversation.
- **Computing** — Python/R kernels, Jupyter Lab, experiment runs, large-file probing, compute requirements, local jobs, cancellation, timeout, and logs.
- **Skill-driven runtime** — validated YAML skill packages, source precedence, session snapshots, trigger fixtures, hashed artifacts, literature/PDF/MCP/job/reviewer/bookmark APIs, and prompt-injection checks. See [docs/skill-schema.md](docs/skill-schema.md) and [docs/science-platform-runtime.md](docs/science-platform-runtime.md).
- **Extensions** — MCP bridge, multi-agent subagents, web access, and context-mode sandboxed execution with an FTS5 knowledge index.
- **Workspace isolation** — per-workspace sessions, provenance, runs, configuration, and security validation.
- **Internationalization** — English is the default; Simplified Chinese is available from Settings → General.

## Pages

| Page | Route | Purpose |
|---|---|---|
| Projects | `/` | Create, open, or delete workspaces |
| Workspace / Chat | `/workspace/:cwd` | Resume or create conversations |
| Files | `/workspace/:cwd/files` | Browse and preview workspace files |
| Notebooks | `/workspace/:cwd/notebooks` | Run notebooks and manage Jupyter Lab |
| Runs | `/workspace/:cwd/runs` | Inspect experiment history |
| Project Knowledge | `/workspace/:cwd/knowledge` | Review proposals and project records |
| Skills | `/skills` | Inspect installed skills and scientific tools |
| Settings | `/settings` | Configure providers, models, extensions, and MCP |

## Quick start

### Prerequisites

- Python 3.11+ with `pip` (Conda is optional)
- Node.js 22+
- An LLM API key, such as `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENAI_API_KEY`

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
bash scripts/dev.sh
```

The development script starts:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`
- API docs: `http://127.0.0.1:8787/docs`

Then open Settings → LLM and enter your provider key. Jupyter Lab is optional; install it with `python -m pip install jupyterlab` if you want the separate Jupyter button.

## Development checks

```bash
cd backend && uv run pytest -q
cd frontend && npm test -- --run
cd frontend && npm run build
```

Browser UAT scripts are available as `npm run test:uat:knowledge`, `test:uat:notebook`, `test:uat:office`, and `test:uat:conversation`.

## Tech stack

React 19 · TypeScript 6 · Vite 8 · Tailwind CSS · Zustand · FastAPI · Uvicorn · Pydantic · SSE · Three.js · 3Dmol.js · OpenChemLib

## License

MIT
