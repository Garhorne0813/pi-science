<div align="center">
  <img src="frontend/src/assets/hero.png" alt="Pi-Science" width="160" />
  <h1>Pi-Science</h1>
  <p><strong>面向科研、计算与可复现发现的开源科学 AI 工作台。</strong></p>
  <p>
    在一个工作区中与 AI 智能体协作、运行科学代码、查看数据、管理项目知识，
    并追踪每个产物的完整来源。
  </p>
  <p>
    <a href="README.md">English</a>
    · <a href="#快速开始">快速开始</a>
    · <a href="#系统架构">系统架构</a>
    · <a href="#开发与测试">开发与测试</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22.12+" />
    <img src="https://img.shields.io/badge/Python-%E2%89%A53.11-3776AB?logo=python&logoColor=white" alt="Python 3.11+" />
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111" alt="React 19" />
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
  </p>
</div>

---

大多数 AI 科研工具止步于阅读和总结论文。Pi-Science 围绕「一个聊天窗口做不到的事」构建：

- **执行，而不只是解释。**回答里的 Python 代码块一键在真实的工作区内核上运行——状态跨代码块保持，一场对话同时就是一次可交互的分析会话。
- **可复现是副作用，不是美德。**每次运行进入事件日志、产物带 sha256 摘要、每个工作区拥有隔离环境，结论可以追溯到产生它的代码与数据——不需要你改变工作方式。
- **自主研究循环，人保持掌控。**描述目标和确定性指标；受监督的智能体提出候选方案、在不可变快照中执行、评估、分析并迭代——带预算控制、暂停恢复和崩溃自愈。
- **文献引用真实可验证。**零配置直连 Crossref/arXiv/PubMed 检索，内联 DOI 渲染为可点击的来源——绝不编造参考文献。
- **架构级 local-first。**工作区就是你机器上的普通文件夹。除了你配置的 LLM 调用（也支持 Ollama、LM Studio 等纯本地端点），任何数据不离开本机。未发表的数据始终属于你。

每个项目独立保存对话、文件、实验运行、产物谱系和审核后的项目知识；对话在共享 Pi Host 内使用隔离 runtime，因此多个 session 可以并行执行，互不阻塞。

## 快速开始

### 环境要求

- Node.js 22.12 或更高版本
- Python 3.11 或更高版本
- pnpm
- 一个 LLM 提供商 API Key，或可信的 OpenAI / Anthropic 兼容本地端点
- Windows：PowerShell 5.1 或更高版本

### 一键安装并启动

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
bash scripts/dev.sh
```

`dev.sh` 会安装缺失依赖并启动完整的本地服务。

### 分开安装和启动

为本地 checkout 安装一次依赖，然后可独立启动开发服务：

```bash
bash scripts/install.sh
bash scripts/start.sh
```

Windows 使用原生 PowerShell 等价脚本：

```powershell
powershell -File scripts/install.ps1
powershell -File scripts/start.ps1
```

Shell 启动器面向 macOS/Linux 设计，并计划用于 WSL；CI 当前只在 Linux 上验证其生命周期。PowerShell 安装器会下载并校验原生 Windows Pi runtime ZIP，因此 Windows 全新安装不需要 Git Bash。两种启动器都会运行 `tsx watch` 与 Vite 开发服务器，因此不是生产部署服务器。安装完成后的启动过程直接调用 package-local 可执行文件，因此运行时不需要 npm 或 pnpm wrapper；安装、构建和依赖更新仍然需要 pnpm。

### `pi-science` 命令

`scripts/install.sh` 会在 `~/.local/bin` 生成 `pi-science` 启动器（可用 `PI_SCIENCE_BIN_DIR` 指定其它目录）。只要该目录在 `PATH` 中：

```bash
pi-science                  # 启动全部服务并打开浏览器
pi-science start --detach   # 改为后台常驻
pi-science status           # 查看当前运行状态
pi-science stop             # 停止本仓库启动的服务
```

Windows 安装完成并打开新终端后，可直接使用：

```powershell
pi-science              # 启动全部服务
pi-science start        # 启动全部服务
pi-science status       # 查看当前状态
pi-science stop         # 停止服务
pi-science help         # 查看帮助
```

Windows 启动器在两个服务健康后写入 `.runtime/pi-science/run.state`，停止时优先按状态文件精确命中进程；状态文件不可用时回退到本机端口探测。不加 `--detach` 时，Bash 版 `pi-science` 会占用当前终端，Ctrl+C 停止；PowerShell 版同样只支持前台运行。两种启动器都使用端到端就绪期限（`PI_SCIENCE_STARTUP_TIMEOUT_SECONDS`，默认 90 秒）。生成的启动器会拒绝覆盖无关文件、目录、symlink 或 Windows 可执行文件冲突；重复运行安装器可以安全更新属于同一 checkout 的启动器。

仓库移动后，或者 `git pull` 修改了 `package.json`、`pnpm-lock.yaml`、Python 依赖元数据或 Pi runtime 版本时，需要重新运行对应平台的安装器（`scripts/install.sh` 或 `powershell -File scripts/install.ps1`）；只有源码变化时不需要重装。安装后，macOS/Linux 可运行 `bash scripts/start.sh`，Windows 可运行 `powershell -File scripts/start.ps1`。如果继续使用 `dev.sh`，但希望跳过安装：

```bash
PI_SCIENCE_SKIP_INSTALL=1 bash scripts/dev.sh
```

启动后进入 **Settings → LLM**，配置提供商和默认模型即可开始使用。

## 核心能力

| 领域 | Pi-Science 提供的能力 |
|---|---|
| 智能体工作区 | 流式对话、工具卡片、Markdown、LaTeX、斜杠命令和交互式扩展请求 |
| 并行会话 | 活跃、恢复和分叉的对话在同一个 Pi Host 内使用相互隔离的 runtime |
| 科学文件 | 原生预览分子结构、FITS、基因组、相图、3D 模型、表格、办公文档、媒体和代码 |
| 可复现性 | 产物哈希、生成代码与差异、环境快照、谱系历史和一键复现 |
| 项目记忆 | Reviewer 提案、人工审核、证据链接、项目版本、研究循环和 Pareto 前沿 |
| 科学计算 | Python/R 内核、Notebook、实验运行、任务控制、大文件探测和可选 Jupyter Lab |
| 扩展能力 | Pi skills、扩展、MCP、subagents、自定义模型提供商和托管端点 |
| 工作区安全 | 项目级元数据、路径校验、会话状态隔离和受控的模型端点发现 |

## 科学文件查看器

Pi-Science 可以直接在浏览器中渲染常见科研格式。

| 领域 | 格式 | 查看器 |
|---|---|---|
| 化学 | CIF、PDB、SDF、MOL、SMILES、XYZ | 3Dmol.js 交互式三维查看器 |
| 天文 | FITS | Canvas 渲染和科学色图 |
| 3D / CAD | STL、OBJ、PLY、glTF、GLB | Three.js 场景查看器 |
| 固体物理 | EIGENVAL、DOSCAR | 能带和态密度图 |
| 基因组 | BED、GFF、GTF、VCF | 轨道式基因组查看器 |
| 表格数据 | CSV、TSV | 可排序表格及折线、柱状、散点图 |
| 办公文档 | DOCX、XLSX、PPTX | 浏览器原生文档预览 |
| 通用格式 | Markdown、JSON、代码、图片、PDF、视频 | 语法感知或浏览器原生预览 |

## 系统架构

Pi-Science 使用 local-first 控制面、一个承载隔离 agent runtime 的共享 Pi Orbit
Web Host，以及按需启动的科学计算服务。进程归属、服务边界、工作区状态、生命周期和
安全设计详见[架构文档](docs/architecture.zh-CN.md)。

## 斜杠命令

在对话输入框中输入 `/` 即可打开命令菜单。

| 命令 | 作用 |
|---|---|
| `/compact` | 压缩对话上下文 |
| `/export <html\|jsonl>` | 导出对话历史 |
| `/skill:<name>` | 调用动态发现的工作区技能 |

Pi-Science 托管的工作区默认信任 `.pi/skills/`；其中的项目内置 skills 会参与 Pi 的命令发现。

## 模型配置

可以在 **Settings → LLM** 中配置提供商。Pi-Science 支持内置厂商、OpenAI-compatible、Anthropic-compatible，以及 Ollama、LM Studio 等可信的无 Key 本地服务。

也可以通过环境变量提供 API Key：

```bash
export OPENAI_API_KEY=sk-...
# 也可以使用 ANTHROPIC_API_KEY、DEEPSEEK_API_KEY 等受支持的厂商变量
```

## 开发与测试

```bash
# JavaScript / TypeScript 测试
pnpm test

# 静态类型检查
pnpm typecheck

# 生产构建
pnpm build

# Python 测试
uv run --directory backend pytest -q
```

补充端到端检查：

```bash
pnpm smoke
pnpm uat:conversation
PI_CLI_PATH=/absolute/path/to/pi-orbit pnpm smoke:real-pi
```

前端专项 UAT：

```bash
pnpm --filter frontend test:uat:knowledge
pnpm --filter frontend test:uat:notebook
pnpm --filter frontend test:uat:office
```

## 文档

- [架构文档](docs/architecture.zh-CN.md)
- [研究循环架构（ADR）](docs/adr-research-loop-subagents.md)
- 运行栈启动后可查看交互式 API 参考

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行相关测试，以及 `pnpm typecheck` 和 `pnpm build`。修改运行时行为时，应同时补充回归测试。

## 许可证

MIT
