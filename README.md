# Pi-Science

**Scientific AI Workbench**

Pi-Science is a web-native workbench where scientists converse with AI agents to explore data, write analysis code, visualize results, and track every artifact's lineage — all in the browser.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

---

## Features · 功能特色

### Agent Chat · 智能体对话

The core interface: a streaming chat where AI agents write, execute, and visualize scientific code in real time.

核心交互界面：与 AI 智能体实时对话，智能体即时编写、执行科学代码并生成可视化结果。

- **Streaming responses** — SSE-based real-time output, every tool call rendered as an expandable card
- **LLM providers** — a built-in vendor catalog plus OpenAI-compatible and Anthropic-compatible custom providers, all switchable in Settings
- **Model controls** — choose a default model from configured providers and expose only the reasoning levels supported by that model
- **Tool visualization** — file writes, shell commands, and code execution expand inline with syntax-highlighted diffs
- **Markdown rendering** — agent responses support tables, code blocks, LaTeX math, and file-path detection
- **Session management** — create, resume, fork, and delete conversations; history preserved per workspace
- **Minimal workspace contract** — only `AGENTS.md` is seeded; reviewed project memory is created lazily and maintained by the workbench
- **Slash commands** — type `/` in the composer to access built-in commands (`/new`, `/model`, `/compact`, `/copy`, `/export`, `/name`, `/session`) and dynamic ones from skills and extensions
- **Skill commands** — skills installed in `.pi/skills/` register as `/skill:<name>` commands that invoke the skill through the agent
- **Interactive prompts** — extension confirm/select/input/editor requests render as inline cards you can answer without leaving the chat
- **Resilient streaming** — reconnecting SSE replays missed events (`Last-Event-ID` cursors), one runtime per workspace with a busy guard, and page reloads merge durable history with live output

### Slash Commands · 斜杠命令

Type `/` in the composer to bring up the command menu. Built-in commands execute UI actions; skill and extension commands are forwarded to the agent.

在输入框中输入 `/` 即可唤出命令菜单。内置命令直接执行 UI 操作；技能和扩展命令则转发给智能体处理。

| Command · 命令 | Action |
|---|---|
| `/new` | Start a new session · 新建会话 |
| `/model <provider/model>` | Switch the active model · 切换模型 |
| `/compact` | Manually compact session context · 压缩上下文 |
| `/name <name>` | Rename current session · 重命名会话 |
| `/copy` | Copy last agent reply to clipboard · 复制回复 |
| `/export <html\|jsonl>` | Export session to file · 导出会话 |
| `/session` | Show session info and stats · 会话统计 |
| `/skill:<name>` | Invoke a workspace skill via the agent · 调用技能 |

### Project Memory & Research · 项目记忆与研究循环

Project Memory connects reviewed knowledge, runs, artifacts, result reviews, and Research Loops in one view. Conversations and project files are analyzed for useful knowledge, but nothing enters the formal project record until the user accepts it. `PROJECT.md` is created only after the first accepted knowledge item.

项目记忆把已审核知识、运行、产物、结果审查和研究循环放在一个视图中。系统会从对话和项目文件中识别有效知识，但只有用户确认后才能写入正式项目记录；`PROJECT.md` 在首条知识获批后才会生成。

- **Proposal-only Reviewer** — extracts findings, conclusions, decisions, hypotheses, open questions, tasks, project changes, and artifacts
- **Evidence links** — proposals retain their source session, message IDs, related files, confidence, and conflicts
- **Human approval** — accept, edit, reject, or batch-review proposals before they update `PROJECT.md`
- **Automatic or manual review** — run silently after settled conversations, or trigger “Review” from the composer
- **Hybrid file organization** — shallow physical folders plus logical views by type, topic, and time
- **Safe file plans** — preview moves/renames, detect collisions and references, execute transactionally, and undo from history
- **Project versions** — every reviewed document update creates a restorable project-document version
- **Per-project policy** — lock paths, set naming conventions, and learn from accepted/rejected proposal categories
- **Research Loops** — create measurable loops, pin evaluator versions, execute immutable candidate snapshots, enforce budgets, and inspect the Pareto frontier
- **Unified traceability** — navigate Candidate → Run → Evaluation → Experience → Knowledge without asking the agent to synchronize duplicate summaries

Project Memory is lazy by default: a new workspace does not pre-create `KNOWLEDGE.md`, `knowledge/`, `notes/`, `PROJECT.md`, or a Project Knowledge folder tree. The workbench creates reviewed-knowledge state only when it is first needed. New Research Loop control events share one append-only `.pi-science/research-records.jsonl`; Experience, loop state, timeline, indexes, and frontier are derived views rather than additional agent-maintained logs.

### Scientific File Viewers · 科学文件查看器

15+ built-in viewers render scientific data formats natively in the browser. No plugin needed.

内置 15+ 种文件查看器，无需插件即可在浏览器中原生渲染科学数据格式。

| Category · 类别 | Formats · 格式 | Renderer |
|---|---|---|
| **Astronomy · 天文** | FITS | Canvas + color maps (magma, viridis, gray) |
| **Chemistry · 化学** | CIF, PDB, SDF, MOL, SMILES, XYZ | 3D WebGL (3Dmol.js) — rotate, zoom, measure |
| **3D / CAD** | STL, OBJ, PLY, glTF, GLB | WebGL (Three.js) — orbit, pan, wireframe |
| **Solid-state Physics · 固体物理** | EIGENVAL, DOSCAR | SVG band-structure & DOS charts |
| **Phase Diagrams · 相图** | JSON phase data | Convex-hull analysis with phase labels |
| **Genomics · 基因组** | BED, GFF, GTF, VCF | Canvas genome browser with annotation tracks |
| **Tabular Data · 表格数据** | CSV, TSV | Sortable HTML table + SVG charts (line, bar, scatter) |
| **Office Documents** | DOCX, XLSX, PPTX | Native JS renderers — no Office required |
| **Code · 代码** | Python, R, Bash, Markdown, JSON | Syntax highlighting (highlight.js) |
| **Images & Media** | PNG, JPEG, GIF, SVG, PDF, MP4 | Native `<img>`, `<iframe>`, `<video>` |

### File Browser · 文件浏览器

A persistent sidebar that mirrors the workspace directory — browse, preview, and manage files without leaving the conversation.

持久化侧边栏，镜像工作区目录——无需离开对话即可浏览、预览、管理文件。

- Click any file to preview in the right inspector panel
- Right-click context menu: copy name, copy path, delete
- Drag-and-drop file upload into workspace
- Breadcrumb navigation in the full Files page

### Inspector Panel · 检查器面板

The right-side panel that adapts to what you select — preview, provenance, or notebook.

右侧面板根据选择内容自适应切换——文件预览、版本谱系或交互式笔记本。

- **File Preview** — code, tables, molecules, FITS images, genome tracks, and more
- **Version History** — every write/edit recorded; expand any version to see who (which model), how (which tool), and the full code or diff
- **Notebook** — Python/R kernel with cell-based interface for interactive exploration
- **HTML preview** — render exported HTML artifacts with external stylesheets while keeping preview scope inside the workspace

### Provenance Tracking · 谱系追踪

Every file the agent creates or edits is automatically recorded with full lineage. Click the history button (clock icon) in any file preview to see:

智能体创建或修改的每一个文件都会被自动记录完整谱系。点击文件预览中的历史按钮即可查看：

- **Tool & model** — which tool wrote it and which model was thinking
- **Code & diff** — the exact generating code or the edit diff
- **Environment snapshot** — Python version, platform, `pip freeze` lockfile (one-click to view)
- **Reproduce** — one-click draft a reproduce prompt to regenerate and compare
- **Conversation link** — jump to the originating session

### Computing · 计算

- **Python / R Kernels** — persistent, isolated sessions per notebook; execute code and capture output
- **Skill validation & reproducibility** — validate skill metadata, evaluate trigger fixtures, publish hashed artifacts, and inspect session skill snapshots
- **Jupyter Lab** — one-click start/stop from the Notebooks page; opens in a new browser tab
- **Large File Probe** — structure detection for files too large to preview (CSV, NetCDF, FITS, Parquet, STL, genomics); shows schema, row counts, column types, sample values without loading the entire file
- **Experiment Runs** — track commands, outputs, and status in `.pi-science/runs.jsonl`

### Extensions · 扩展

| Extension · 扩展 | What it does · 功能 |
|---|---|
| **pi-mcp-adapter** | Bridge to MCP servers — literature search (PubMed, arXiv), biomed, materials databases, weather |
| **pi-subagents** | Multi-agent orchestration: scout, researcher, planner, worker, reviewer, oracle |
| **pi-web-access** | Web search, URL fetching, YouTube/video understanding |
| **context-mode** | Sandboxed code execution (12 languages) + FTS5 knowledge index for long scientific sessions |

### Skill-driven research runtime · 技能驱动科研运行时

Skills are validated YAML-described capability packages rather than bare
prompt files. The workbench records the skill digest loaded for each session,
publishes user-visible artifacts with content hashes and verification status,
and exposes read-only literature, PDF page-index, MCP catalog, job, result
review, and transcript bookmark APIs. See [docs/skill-schema.md](docs/skill-schema.md)
and [docs/science-platform-runtime.md](docs/science-platform-runtime.md).

### Workspaces · 工作区

- **Projects page** — card grid of workspaces, create new or open existing folders
- **Session isolation** — each workspace has its own `.pi-science/` directory with sessions, provenance, and runs
- **Per-workspace configuration** — different API keys, models, and MCP servers per project
- **Workspace safety** — the managed workspace root is never a project; startup discovery only registers initialized child workspaces with a `.pi-science` marker

### Theme & Internationalization · 主题与国际化

- **Warm paper aesthetic** — cream whites, soft shadows, serif headings; dark mode via `[data-theme="dark"]`
- **English & Simplified Chinese** — auto-detected on first launch, switchable in Settings → General; covers the workbench shell, Project Memory, and the scientific inspectors (an i18n coverage test keeps both locales in sync)
- **Resizable panels** — drag to resize sidebar, inspector, and composer

### LLM Provider Configuration · LLM 提供商配置

The Settings → LLM page separates model selection from provider setup:

- **Default Model** — select from models exposed by configured providers
- **Thinking Level** — the control is derived from the selected model's capabilities; unsupported levels are not offered
- **Model Vendors** — configure keys for built-in vendors such as Anthropic, OpenAI, Google, DeepSeek, Groq, OpenRouter, Mistral, Z.AI, MiniMax, and others
- **Custom** — discover models from OpenAI-compatible, OpenAI Responses, or Anthropic Messages endpoints
- **Managed Model Endpoints** — register local or remote model services as an advanced integration

API keys are stored in the Pi-Science configuration directory. Custom provider model discovery is kept separate from the built-in vendor catalog so the default model list remains predictable.

---

## User Interface · 用户界面

### Pages · 页面

| Page · 页面 | Route · 路由 | What you do there |
|---|---|---|
| **Projects** | `/` | Workspace cards — create, open, or delete project folders |
| **Workspace** | `/workspace/:cwd` | Open a project and resume or create its conversations |
| **Chat** | `/workspace/:cwd/session/:sessionId` | Agent conversation — streaming responses, tool cards, file previews |
| **Files** | `/workspace/:cwd/files` | Full file browser — breadcrumb nav, table/chart views for data files |
| **Notebooks** | `/workspace/:cwd/notebooks` | Open and run .ipynb files; manage the workspace's Jupyter Lab server |
| **Runs** | `/workspace/:cwd/runs` | Experiment history — command, status, host, outputs |
| **Project Memory** | `/workspace/:cwd/knowledge` | Review knowledge proposals, inspect runs and artifacts, manage Research Loops, view the Pareto frontier, and browse the unified history |
| **Skills** | `/skills` | Installed agent skills and scientific tool detection |
| **Settings** | `/settings` | LLM config, API keys, model selection, extensions, MCP servers |

### Layout · 布局

```
┌─ Header ──────────────────────────────────────────────────────┐
│  [Projects]  [Chat]  [Files]  [Notebooks]  [Runs]  [Skills]  [Settings]  │
├─ Sidebar ───┬─ Center (Chat / Content) ──┬─ Inspector ───────┤
│  File tree  │  Agent messages            │  File preview     │
│  (browse,   │  Tool cards                │  Version history  │
│   right-    │  Code blocks               │  Notebook cells   │
│   click)    │  Markdown                  │                   │
│             │  Composer (type / for      │                   │
│             │  slash commands)            │                   │
├─────────────┴────────────────────────────┴───────────────────┤
│  Status bar: pi processes · kernel sessions · health          │
└──────────────────────────────────────────────────────────────┘
```

---

## Quick Start · 快速开始

### Prerequisites · 前置条件

- **Python** ≥ 3.11 with `pip` (Conda is optional)
- **Node.js** ≥ 22
- **LLM API key** — e.g. `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, or `OPENAI_API_KEY`

### One command · 一行命令

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
bash scripts/dev.sh
```

This installs everything and starts both servers:
- **Frontend** → `http://127.0.0.1:5173`
- **Backend** → `http://127.0.0.1:8787`
- **API docs** → `http://127.0.0.1:8787/docs`

Then open Settings → LLM, enter your API key, and start a conversation.

Jupyter Lab is optional because `.ipynb` files can run directly in Pi-Science. To use the separate “Open Jupyter Lab” button, install it into the same Python environment with `python -m pip install jupyterlab`.

### Development checks · 开发检查

```bash
cd backend && uv run pytest -q
cd frontend && npm test -- --run
cd frontend && npm run build
```

The frontend also includes focused UAT scripts:

```bash
cd frontend
npm run test:uat:conversation
npm run test:uat:knowledge
npm run test:uat:notebook
npm run test:uat:office
```

### Configure API Key · 配置 API 密钥

Set via the Settings UI (`http://127.0.0.1:5173/settings` → LLM tab) or environment variable:

```bash
export DEEPSEEK_API_KEY=sk-...   # or ANTHROPIC_API_KEY, OPENAI_API_KEY
```

---

## Tech Stack · 技术栈

| Layer · 层级 | Technology |
|---|---|
| **Frontend** | React 19, TypeScript 6, Vite 8, Tailwind CSS 3, Zustand 5, React Router 7 |
| **Backend** | Python 3.11+, FastAPI, Uvicorn, Pydantic, sse-starlette |
| **Agent Runtime** | pi (Node.js, JSONL RPC over stdin/stdout) |
| **3D** | Three.js, 3Dmol.js |
| **Chemistry** | OpenChemLib |
| **Documents** | docx-preview, ExcelJS, pptx-preview |
| **Code** | highlight.js |
| **Fonts** | Inter, Source Serif 4, JetBrains Mono |

## License

MIT
