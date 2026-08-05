<div align="center">
  <img src="frontend/src/assets/hero.png" alt="Pi-Science" width="160" />
  <h1>Pi-Science</h1>
  <p><strong>An open scientific AI workbench for research, computation, and reproducible discovery.</strong></p>
  <p>
    Chat with AI agents, run scientific code, inspect data, manage project knowledge,
    and trace every generated artifact back to its source.
  </p>
  <p>
    <a href="README.zh-CN.md">简体中文</a>
    · <a href="#quick-start">Quick Start</a>
    · <a href="#architecture">Architecture</a>
    · <a href="#development">Development</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22.12+" />
    <img src="https://img.shields.io/badge/Python-%E2%89%A53.11-3776AB?logo=python&logoColor=white" alt="Python 3.11+" />
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111" alt="React 19" />
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
  </p>
</div>

---

Most AI research tools stop at reading and summarizing papers. Pi-Science is built around the things an open chat tab **cannot** do:

- **Execute, don't just explain.** Python code blocks in any answer run on a real workspace kernel with one click — state persists across blocks, so a conversation is also a live analysis session.
- **Reproducibility as a side effect, not a virtue.** Every run lands in an event log, artifacts carry sha256 digests, each workspace gets an isolated environment, and results trace back to the code and data that produced them — without changing how you work.
- **Autonomous research loops with a human in charge.** Describe an objective and a deterministic metric; a supervised agent proposes candidates, executes them in immutable snapshots, evaluates, analyzes, and iterates — with budgets, pause/resume, and crash recovery.
- **Literature with real, verifiable citations.** Zero-config Crossref/arXiv/PubMed retrieval with inline DOIs rendered as clickable sources — never invented references.
- **Local-first by architecture.** Workspaces are plain folders on your machine. Nothing leaves it except the LLM calls you configure — including fully local endpoints such as Ollama or LM Studio. Unpublished data stays yours.

Each project keeps its own conversations, files, runs, provenance, and reviewed knowledge. Conversations run in isolated runtimes inside a shared Pi host, so multiple sessions continue concurrently without blocking one another.

## Quick Start

### Requirements

- Node.js 22.12 or newer
- Python 3.11 or newer
- pnpm
- An LLM provider API key, or a trusted OpenAI/Anthropic-compatible local endpoint
- Windows: PowerShell 5.1 or newer

### One-command setup

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
bash scripts/dev.sh
```

`dev.sh` installs missing dependencies and starts the complete local stack.

### Separate installation and startup

For a repeatable local checkout, install dependencies once and start the development services independently:

```bash
bash scripts/install.sh
bash scripts/start.sh
```

On Windows, use the native PowerShell equivalents:

```powershell
powershell -File scripts/install.ps1
powershell -File scripts/start.ps1
```

The Bash launcher is designed for macOS/Linux and is intended to run under WSL; CI validates its lifecycle on Linux. The PowerShell installer downloads and verifies the native Windows Pi runtime ZIP, so Git Bash is not required for a fresh Windows installation. Both launchers deliberately run `tsx watch` and the Vite development server, so they are not production deployment servers. Starting an installed checkout invokes package-local executables directly, so npm and pnpm wrappers are not runtime requirements; pnpm is still required for installation, builds, and dependency updates.

### The `pi-science` command

`scripts/install.sh` also puts a `pi-science` launcher in `~/.local/bin` (override with `PI_SCIENCE_BIN_DIR`). Once that directory is on your `PATH`:

```bash
pi-science                  # start everything and open the browser
pi-science start --detach   # keep it running in the background instead
pi-science status           # report what is currently running
pi-science stop             # stop the services started from this checkout
```

On Windows, open a new terminal after `scripts/install.ps1` updates `PATH`, then use the foreground launcher:

```powershell
pi-science              # start everything
pi-science start        # start everything
pi-science status       # report what is currently running
pi-science stop         # stop the services
pi-science help         # show command help
```

The Windows launcher writes `.runtime/pi-science/run.state` after both services are healthy and uses it for precise shutdown, with a local-port fallback when state is unavailable. Without `--detach`, the Bash `pi-science` command holds the terminal and Ctrl+C stops it, exactly like `bash scripts/start.sh`; the PowerShell launcher is also foreground-only. Both launchers use an end-to-end readiness deadline (`PI_SCIENCE_STARTUP_TIMEOUT_SECONDS`, default 90 seconds). The generated launchers refuse to overwrite an unrelated file, directory, symlink, or Windows executable collision; re-running the installer safely updates a launcher owned by the same checkout.

Re-run the platform-appropriate installer (`scripts/install.sh` or `powershell -File scripts/install.ps1`) after moving the checkout or after a `git pull` changes `package.json`, `pnpm-lock.yaml`, Python dependency metadata, or the Pi runtime version. Source-only changes do not require reinstalling. After installation, use `bash scripts/start.sh` on macOS/Linux or `powershell -File scripts/start.ps1` on Windows; to keep using `dev.sh` while skipping installation, run:

```bash
PI_SCIENCE_SKIP_INSTALL=1 bash scripts/dev.sh
```

Open **Settings → LLM** after startup and configure a provider and default model.

## Highlights

| Area | What Pi-Science provides |
|---|---|
| Agent workspace | Streaming conversations, tool cards, Markdown, LaTeX, slash commands, and interactive extension prompts |
| Concurrent sessions | Isolated runtimes for active, restored, and forked conversations inside one shared Pi host |
| Scientific files | Native previews for molecular structures, FITS, genomics, phase data, 3D models, tables, office documents, media, and code |
| Reproducibility | Artifact hashes, generating code and diffs, environment snapshots, provenance history, and reproduce actions |
| Project memory | Reviewer proposals, human approval, evidence links, project versions, research loops, and Pareto-frontier tracking |
| Computation | Python/R kernels, notebooks, experiment runs, job control, large-file probing, and optional Jupyter Lab |
| Extensibility | Pi skills, extensions, MCP servers, subagents, custom model providers, and managed endpoints |
| Workspace safety | Project-scoped metadata, validated paths, isolated session state, and controlled outbound provider discovery |

## Scientific Viewers

Pi-Science renders common research formats directly in the browser.

| Domain | Formats | Viewer |
|---|---|---|
| Chemistry | CIF, PDB, SDF, MOL, SMILES, XYZ | Interactive 3Dmol.js viewer |
| Astronomy | FITS | Canvas rendering with scientific color maps |
| 3D / CAD | STL, OBJ, PLY, glTF, GLB | Three.js scene viewer |
| Solid-state physics | EIGENVAL, DOSCAR | Band-structure and density-of-states charts |
| Genomics | BED, GFF, GTF, VCF | Track-based genome viewer |
| Tabular data | CSV, TSV | Sortable tables and line, bar, and scatter charts |
| Office | DOCX, XLSX, PPTX | Browser-native document previews |
| General | Markdown, JSON, code, images, PDF, video | Syntax-aware or native previews |

## Architecture

Pi-Science uses a local-first control plane, one shared Pi Orbit Web host with
isolated agent runtimes, and an on-demand scientific worker. See the
[architecture reference](docs/architecture.md) for process ownership, service
boundaries, workspace state, lifecycle, and security details.

## Slash Commands

Type `/` in the conversation composer to open the command menu.

| Command | Action |
|---|---|
| `/compact` | Compact conversation context |
| `/export <html\|jsonl>` | Export conversation history |
| `/skill:<name>` | Invoke a dynamically discovered workspace skill |

Pi-Science-managed workspaces trust `.pi/skills/` by default; these project-built-in skills participate in Pi command discovery.

## Model Configuration

Providers can be configured from **Settings → LLM**. Pi-Science supports built-in vendors, OpenAI-compatible endpoints, Anthropic-compatible endpoints, and trusted keyless local services such as Ollama or LM Studio.

API keys may also be provided through environment variables:

```bash
export OPENAI_API_KEY=sk-...
# or ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, and other supported vendors
```

## Development

```bash
# JavaScript and TypeScript tests
pnpm test

# Static checks
pnpm typecheck

# Production build
pnpm build

# Python tests
uv run --directory backend pytest -q
```

Additional end-to-end checks:

```bash
pnpm smoke
pnpm uat:conversation
PI_CLI_PATH=/absolute/path/to/pi-orbit pnpm smoke:real-pi
```

Focused frontend UAT commands:

```bash
pnpm --filter frontend test:uat:knowledge
pnpm --filter frontend test:uat:notebook
pnpm --filter frontend test:uat:office
```

## Documentation

- [Architecture](docs/architecture.md)
- [Research loop architecture (ADR)](docs/adr-research-loop-subagents.md)
- Interactive API reference while the stack is running

## Contributing

Issues and pull requests are welcome. Before submitting a change, run the relevant tests plus `pnpm typecheck` and `pnpm build`. Changes to runtime behavior should include regression coverage.

## License

MIT
