# Pi-Science

**Scientific AI Workbench — powered by the [pi](https://github.com/earendil-works/pi) agent runtime.**

Pi-Science is a web application that combines a coding AI agent with scientific computing capabilities. It wraps pi's agent runtime in a Python FastAPI backend and provides a React + Vite frontend.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  React + Vite Frontend                       │
│  Projects · Chat · Files · Notebooks · Runs  │
│  15+ Scientific Viewers · Skills · Settings  │
└──────────────┬───────────────────────────────┘
               │ HTTP REST + SSE
┌──────────────▼───────────────────────────────┐
│  Python FastAPI Backend                      │
│  Sessions · Files · Kernels · Notebooks      │
│  Provenance · Runs · Skills · Settings       │
│  Workspaces · MCP Config · Large File Probe  │
└──────────────┬───────────────────────────────┘
               │ stdin/stdout JSONL RPC
┌──────────────▼───────────────────────────────┐
│  pi Agent Runtime (Node.js subprocess)       │
│  25+ LLM Providers · Agent Loop · Tools      │
│  Extensions: MCP Adapter · Subagents · Web   │
└──────────────────────────────────────────────┘
```

- **Frontend**: React 18 + TypeScript + Vite 5 + Tailwind CSS 3 + Zustand 5
- **Backend**: Python 3.11+ · FastAPI · SSE via sse-starlette
- **Agent Runtime**: pi (Node.js) in RPC mode, JSONL over stdin/stdout
- **Scientific computing**: Native Python subprocesses (kernels, format parsers)

## Features

### Workspace Management
- **Projects page** — create or open local folders as workspaces
- **Session history** — per-workspace session list with automatic naming
- **File browser** — sidebar panel with right-click copy/delete

### Agent Chat
- Real-time streaming via SSE with any LLM provider (25+)
- Tool execution visualization with collapsible tool groups
- Session management: create, switch, delete, history loading
- **AGENTS.md / KNOWLEDGE.md** auto-seeded per workspace
- Markdown rendering with file reference detection

### Pi Extensions
| Extension | Description |
|-----------|-------------|
| **pi-mcp-adapter** | MCP server bridge — literature search, biomed, materials, weather |
| **pi-subagents** | Child agents: scout, researcher, planner, worker, reviewer, oracle |
| **pi-web-access** | Web search, URL fetch, YouTube/video understanding |

### Scientific File Viewers (15+ formats)
| Category | Formats | Renderer |
|----------|---------|----------|
| Astronomy | FITS | Canvas + color maps (magma, viridis, gray) |
| Chemistry | CIF, PDB, SDF, MOL, SMILES, XYZ | 3D WebGL (3Dmol.js) |
| 3D/CAD | STL, OBJ, PLY, glTF, GLB | WebGL (Three.js) |
| Physics | EIGENVAL, DOSCAR, phase diagrams | SVG charts |
| Genomics | BED, GFF, GTF, VCF | SVG genome browser |
| Data | CSV, TSV | HTML table + SVG charting |
| Documents | DOCX, XLSX, PPTX | Native JS renderers |
| Code | Python, R, Bash, Markdown | Syntax-highlighted |

### Pages
| Page | Description |
|------|-------------|
| **Projects** | Landing page — workspace cards, create/open folders |
| **Chat** | Agent conversation with streaming + tool cards |
| **Files** | Full file browser with breadcrumb navigation |
| **Notebooks** | .ipynb listings + Jupyter Lab start/stop |
| **Runs** | Experiment run history with log viewer |
| **Skills** | Installed skills + scientific environment detection |
| **Settings** | LLM (API keys, model, thinking level), Extensions, MCP connectors |

### Computing
- **Python/R kernels**: Execute code via kernel_bridge protocol
- **Jupyter Lab**: One-click start/stop from Notebooks page
- **Provenance tracking**: Append-only JSONL, auto-recorded on file writes
- **Runs history**: Experiment tracking with `.pi-science/runs.jsonl`
- **Large file probe**: Structure detection for CSV, NetCDF, FITS, Parquet, STL, genomics

### File Operations
- Drag & drop upload to workspace
- Right-click context menu (copy name/path, delete)
- File preview in right-side inspector panel

### UI
- Warm paper aesthetic (ported from open-science)
- Dark/light theme with CSS custom properties
- Resizable sidebar and inspector panels
- Tab-based settings navigation

## Quick Start

### Prerequisites
- **Python** ≥ 3.11 with `pip`
- **Node.js** ≥ 22
- **conda** (optional, for environment management)
- **LLM API key** — e.g., `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`

### One-command start

```bash
cd pi-science
bash scripts/dev.sh
```

This auto-fetches pi, installs dependencies, and starts both servers:
- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`
- API docs: `http://127.0.0.1:8787/docs`

### Manual start

```bash
# Backend
cd backend
pip install fastapi uvicorn pydantic sse-starlette aiofiles
PI_CLI_PATH=/path/to/pi/packages/coding-agent/dist/cli.js \
  uvicorn main:app --host 127.0.0.1 --port 8787 --reload

# Frontend
cd frontend
npm install
npm run dev
```

### Configure API Key

Open `http://127.0.0.1:5173/settings` → LLM tab → enter API key.

Or set environment variable before starting:
```bash
export DEEPSEEK_API_KEY=sk-...
# or: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
```

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions` | Create session |
| `GET` | `/api/sessions?cwd=…` | List sessions |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `GET` | `/api/sessions/:id/messages` | Message history |
| `POST` | `/api/sessions/:id/prompt` | Send prompt |
| `POST` | `/api/sessions/:id/abort` | Interrupt turn |
| `GET` | `/api/sessions/:id/events` | SSE stream |
| `GET` | `/api/files?cwd=…` | List directory |
| `GET` | `/api/files/{path}` | Read file |
| `GET` | `/api/files/{path}/raw` | Raw download |
| `GET` | `/api/files/{path}/preview` | Preview data |
| `GET` | `/api/files/probe/{path}` | Large file probe |
| `POST` | `/api/files/upload` | Upload file |
| `DELETE` | `/api/files/{path}` | Delete file |
| `POST` | `/api/kernels/execute` | Execute Python/R |
| `GET` | `/api/kernels/status` | Kernel status |
| `GET` | `/api/notebooks` | List .ipynb files |
| `POST` | `/api/notebooks/jupyter/start` | Start Jupyter Lab |
| `POST` | `/api/notebooks/jupyter/stop` | Stop Jupyter Lab |
| `GET` | `/api/runs` | List experiment runs |
| `GET` | `/api/runs/:id/log` | Run log |
| `GET` | `/api/provenance` | Query provenance |
| `GET` | `/api/skills` | List skills |
| `GET` | `/api/skills/tools` | Detected tools |
| `GET` | `/api/settings/config` | Get config |
| `PUT` | `/api/settings/api-key` | Store API key |
| `DELETE` | `/api/settings/api-key/:provider` | Remove API key |
| `PUT` | `/api/settings/model` | Set model |
| `GET` | `/api/settings/providers` | List providers |
| `GET` | `/api/settings/mcp` | MCP server state |
| `PUT` | `/api/settings/mcp/:id` | Toggle MCP server |
| `GET` | `/api/workspaces` | List workspaces |
| `POST` | `/api/workspaces` | Create workspace |
| `POST` | `/api/workspaces/open` | Open folder |
| `POST` | `/api/workspaces/rename` | Rename workspace |
| `GET` | `/api/health` | Health check |

## Project Structure

```
pi-science/
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── api/            # sessions, files, kernels, notebooks, provenance, runs, skills, settings, workspaces
│   ├── services/       # pi_manager, kernel_manager, event_normalizer, file_service, provenance_store, large_file
│   └── tests/          # 76 unit + 21 integration tests
├── frontend/
│   ├── src/
│   │   ├── app/routes/        # ProjectsPage, LiveSessionPage, FilesPage, NotebooksPage, RunsPage, SkillsPage, SettingsPage
│   │   ├── app/layout/        # ProjectsLayout
│   │   ├── components/        # inspector, sidebar, code-viewer, markdown-viewer
│   │   └── lib/               # pi-science-client, runtime-store, store, files, artifacts, viewers/
│   └── vite.config.ts
├── harness/            # AGENTS.md + KNOWLEDGE.md (seeded to new workspaces)
├── demo/               # Climate trends demo data
└── scripts/            # dev.sh, fetch-pi.sh
```

## Configuration

| Path | Purpose |
|------|---------|
| `~/.pi-science/config.json` | API keys, model, thinking level, MCP servers |
| `~/.pi-science/sessions/` | Legacy session storage |
| `.pi-science/sessions/` | Per-workspace session storage |
| `.pi-science/provenance.jsonl` | Artifact provenance |
| `.pi-science/runs.jsonl` | Experiment run records |
| `~/.config/mcp/mcp.json` | MCP server configuration |
| `.pi/skills/` | Project-local agent skills |
| `~/.pi/agent/skills/` | User agent skills |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript 5, Vite 5, Tailwind CSS 3, Zustand 5 |
| Backend | Python 3.11+, FastAPI, sse-starlette, Pydantic |
| Agent Runtime | pi (Node.js, RPC mode) |
| 3D Graphics | Three.js, 3Dmol.js |
| Chemistry | OpenChemLib |
| Documents | docx-preview, ExcelJS, pptx-preview |
| Code | highlight.js |
| Fonts | Inter, Source Serif 4, JetBrains Mono (@fontsource) |

## Development

```bash
# Backend tests
cd backend && pytest tests/ -v              # 76 unit tests
cd backend && pytest tests/test_integration.py -v  # 21 integration tests (requires running backend)

# Frontend
cd frontend
npm run dev          # Dev server with HMR
npm run build        # Production build
npx tsc --noEmit     # TypeScript check
```

## License

MIT
