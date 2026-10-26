<div align="center">
  <img src="frontend/src/assets/hero.png" alt="Pi-Science" width="160" />
  <h1>Pi-Science</h1>
  <p><strong>面向科研、计算与可复现发现的开源科学 AI 工作台。</strong></p>
  <p>
    在一个工作区中与 AI 智能体协作、运行科学代码、查看数据、管理统一记忆，
    并追踪每个产物的完整来源。
  </p>
  <p>
    <a href="README.md">English</a>
    · <a href="#快速开始">快速开始</a>
    · <a href="#系统架构">系统架构</a>
    · <a href="#开发与测试">开发与测试</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A524.16-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24.16+" />
    <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111" alt="React 19" />
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
  </p>
</div>

---

Pi-Science 将 AI 对话、科学计算、数据预览和统一记忆整合到一个本地工作台。

- **在上下文中运行分析。** 在会话内核执行 Python/R 代码，与对话一起查看表格、图像和生成文件。
- **保留执行证据。** 运行记录保存代码、环境版本、产物哈希和谱系，便于检查与复现结果。
- **在对话中开展研究。** Auto Research 技能指导动态子问题、独立审查和任务专属评价，保存恢复检查点，并由运行时限制工具预算。
- **检索科学来源。** 内置连接器获取论文和科学数据，提供可以核对的引用元数据。
- **使用普通项目目录。** 科研文件保存在工作区，模型请求和外部检索使用你配置的服务。

多个对话通过独立 Agent Core Worker 进程并发执行。AgentHarness 管理执行和持久会话，Pi-Science 提供科学工作区与产品界面。

## 快速开始

### 环境要求

- Node.js **24.16+**，包含 npm。安装器自动引导仓库锁定的 **pnpm 11.7.0**，无需全局安装 pnpm。
- Git 用于克隆源码。Python、R 和 Micromamba 环境在使用科学计算功能时按需配置。
- 一个 LLM API Key，或已配置的 Ollama、LM Studio 等本地端点
- Windows 需要 PowerShell **5.1+**

先克隆仓库：

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
```

macOS/Linux 可一键安装并启动：

```bash
bash scripts/dev.sh
```

也可以安装一次，再独立启动：

```bash
bash scripts/install.sh
bash scripts/start.sh
```

原生 Windows 使用 PowerShell：

```powershell
powershell -File scripts/install.ps1
powershell -File scripts/start.ps1
```

打开 **http://127.0.0.1:8787**，在 **设置 → LLM** 配置提供商和默认模型，再打开工作区开始对话。**设置 → Skills** 管理技能，**设置 → MCP** 启用科学连接器；初始启用 Paper Search；在**设置 → 联网搜索**中配置内置网页搜索与抓取。控制面 API 位于同一端口。

Linux/WSL 需要安装 `ripgrep`、`socat` 和 `bubblewrap`（Debian/Ubuntu：`sudo apt-get install ripgrep socat bubblewrap`）。安装、启动和 `pi-science doctor` 都会检查这些工具，并离线验证 Bubblewrap 能否创建隔离命名空间；缺少依赖或系统禁止隔离时，会停止安装/启动并提示原因。

Linux sandbox 中的 MCP 通过受控 HTTP/HTTPS 代理访问网络，域名由宿主侧代理解析；sandbox 内不提供通用 DNS，`/etc/resolv.conf` 不可见或 `socket.getaddrinfo()` 失败不能单独说明 MCP 无法联网。内置检索工具会直接使用该代理。自定义 MCP 也需要使用支持 `HTTP_PROXY`/`HTTPS_PROXY` 的客户端；若宿主机本身无法解析域名，则需要先修复宿主机 DNS。

安装器构建控制面、Agent Worker 和前端。默认启动运行**编译后的 JavaScript**，由控制面在同一个端口提供前端和 API，运行时不使用 Vite 或 tsx。Bash 支持 macOS/Linux 与 WSL，原生 Windows 不需要 Git Bash；Agent Core SDK 随项目依赖安装。

### 启动、诊断与停止

安装器提供 `pi-science` 命令。macOS/Linux 需要将 `~/.local/bin` 加入 `PATH`（可用 `PI_SCIENCE_BIN_DIR` 修改安装目录）；Windows 安装更新 `PATH` 后请打开新终端。

```text
pi-science                 启动生产构建（端口 8787）
pi-science start --dev     启动源码和 Vite（端口 5173）
pi-science install         安装依赖并重新构建
pi-science doctor          诊断生产模式运行条件
pi-science doctor --dev    诊断开发模式运行条件
pi-science logs            输出运行日志
pi-science status          查看服务状态
pi-science stop            停止当前 checkout 的服务
pi-science help            查看命令帮助
```

前台启动占用当前终端，按 **Ctrl+C** 停止服务。Bash 还支持 `pi-science start --detach`；Windows 启动器仅支持前台运行。

移动或更新仓库后，应重新运行对应平台安装器，刷新生产构建产物。只有开发模式会直接使用修改后的源码。组合 Bash 启动器可跳过安装：

```bash
PI_SCIENCE_SKIP_INSTALL=1 bash scripts/dev.sh
```

<details>
<summary>启动器行为与持久状态</summary>

生产启动器直接调用 Node，npm/pnpm 仅用于安装、构建和依赖更新。`doctor` 执行本地检查，不下载软件、不写入持久数据库；检查范围包括运行时、构建和 Worker 文件、依赖、回环端口、目录权限以及 SQLite 内存查询。Python/R/Micromamba 和 LLM 配置作为按需设置单独说明，持久 SQLite 数据库的就绪状态在启动时检查。`doctor` 会检查端口是否可用，因此请先停止运行中的实例，再进行启动前诊断。

开发时使用 `pi-science start --dev`（Node 直接运行 tsx，另启动 Vite）、`bash scripts/start.sh --dev` 或 `powershell -File scripts/start.ps1 -Dev`。设置 `PI_SCIENCE_SERVER_WATCH=1` 才会启用 `tsx watch`；Bash 和 PowerShell 的开发模式均默认直接运行 tsx。`PI_SCIENCE_CONTROL_PLANE_PORT` 修改生产端口，`PI_SCIENCE_FRONTEND_PORT` 仅用于开发模式。两种启动器都将控制面绑定到 `127.0.0.1`。浏览器内部认证 Cookie 不等于用户登录，不应将服务暴露到公网。

pnpm store 默认由多个仓库目录共享：POSIX 使用 `${XDG_CACHE_HOME:-~/.cache}/pi-science/pnpm-store`，Windows 使用 `%LOCALAPPDATA%\pi-science\pnpm-store`。可用 `PNPM_STORE_DIR` 指定独立缓存，包括原先的仓库内 `.cache/pnpm-store`。默认就绪期限为 90 秒，可用 `PI_SCIENCE_STARTUP_TIMEOUT_SECONDS` 调整。启动器根据进程身份停止服务，并拒绝覆盖无关的启动器路径。Windows 停止前检查仓库目录、可执行文件、入口文件、进程创建时间和每次启动的标识；状态缺失或过期时，不会仅凭端口号停止进程。

**更新：** 当前未提供事务式 `update`、`rollback`、`uninstall` 或独立安装包。手动更新源码前，应停止应用并备份应用状态和工作区数据，包括 SQLite 数据库及其 WAL 文件。更新后重新运行安装器。源码降级不能撤销数据库迁移，恢复时需要兼容的应用版本和完整数据备份。验收方式与后续计划见[安装与部署](docs/deployment.zh-CN.md)。

Windows 停止失败时保留身份记录以便重试，并返回退出码 1。Windows 的 `logs` 默认包含控制面和前端的 stdout/stderr，`logs --stderr` 仅显示错误输出。POSIX 前台输出保留在终端，`logs` 读取后台运行日志。启动器与 `doctor` 都将相对的 `PI_SCIENCE_FRONTEND_DIST` 解释为相对于仓库根目录的路径。

应用状态使用 `PI_SCIENCE_HOME` 或 `~/.pi-science`，必要时回退到 checkout 内。项目元数据可位于工作区或应用托管目录，移动或备份前请参阅[数据归属](docs/architecture.zh-CN.md#持久化与数据归属)。旧 v3 会话支持自动转换或[离线转换](docs/agent-core-session-conversion.md)。

</details>

## 核心能力

| 领域 | Pi-Science 提供的能力 |
|---|---|
| 智能体工作区 | 流式对话、工具卡片、Markdown、LaTeX、斜杠命令和浏览器问卷与审批 |
| 并行会话 | 活跃、恢复和分叉的对话使用独立的 Agent Core Worker 进程 |
| 科学文件 | 原生预览分子结构、FITS、基因组、相图、3D 模型、表格、办公文档、媒体和代码 |
| 可复现性 | 实时的会话级执行记录、产物哈希、生成代码与差异、环境快照、谱系历史和一键复现 |
| 记忆 | SQLite 统一记录、版本绑定人工审核、分作用域召回、可选 Extraction/Dream 与共享预算（默认关闭） |
| 科学计算 | 可复用的 Micromamba 环境、隔离的 Python/R Session 内核、可执行 `.ipynb` 文件、与对话关联的运行记录和应用级 Jupyter Lab |
| 扩展能力 | Pi skills、提示模板、MCP、subagents、自定义模型提供商和托管端点 |
| 工作区安全 | 项目级元数据、路径校验、会话状态隔离和受控的模型端点发现 |

## 记忆

在 **设置 → 记忆** 中启用 Memory，全局策略对当前本地用户的所有项目生效。Memory、自动提取 Extraction 和 Dream 默认关闭，分别启用。子选项随开关和触发模式展开，收起时保留已填写的值；模型、审核模式、运行计划和共享后台预算也在这里配置。项目与分类的召回开关保留在项目记忆页面。

记忆页面分为 **记忆、待审核、运行历史** 三个页签。支持关键词搜索、状态/类型/作用域/分类筛选、排序和每页 20 条的分页，显示全部授权匹配记录的总数；手机端以底部抽屉选择条件，点击应用后生效，关闭会放弃本次修改；主页面优先展示记忆列表。条目默认显示紧凑预览和明确状态，展开后查看完整正文、来源、版本与历史；编辑、归档、删除位于“更多”菜单。新增候选展开后提供批准/拒绝操作，修改提案展示当前内容与建议内容对照。待审核内容不参与自动召回。智能审核只允许严格识别的低风险偏好等内容直接生效，科学内容始终需要批准指定版本；全部人工审核会将所有 Agent/后台变更送审。批准表示采用该版本，不表示科学结论已被证明。

记忆保存在应用 SQLite 数据库中，不改写 `PROJECT.md`，也不自动导入旧 ledger / Project Knowledge 数据。作用域、召回、Extraction/Dream、预算、保留与备份详见[统一记忆](docs/unified-memory.md)。

## 会话审批模式

输入框底部的审批模式菜单按会话保存，默认“请求批准”。“帮我批准”允许工作区执行和公网 HTTPS，并自动批准明确声明为安全只读的 MCP 工具；其他需要审批的工具仍会询问。“完全访问”可访问用户目录与项目文件、使用公网 HTTPS，并自动批准工具调用，启用前会显示范围确认。明确的域名和工具禁止规则、应用私有数据以及受限子任务边界始终保留。

模式由后端策略执行，不依赖模型自行判断或批准。任务进行中不能切换；切换会重启该会话的运行环境并清除内核变量。新会话和受限子任务不会自动继承完全访问权限。

## 科学 MCP 连接器

Pi-Science 内置 19 个 MCP 连接器，覆盖公共科学数据服务和通用网页搜索。它们以本地 MCP
进程运行，向 Agent 提供带类型的工具；实际检索仍会向上游服务发送网络请求。

| 连接器 | 上游服务 | 默认状态 |
|---|---|---|
| Paper Search | PubMed、arXiv、Crossref、bioRxiv、medRxiv、Europe PMC | 启用 |
| Literature Graph | OpenAlex | 关闭 |
| Clinical Trials | ClinicalTrials.gov | 关闭 |
| Structures & Interactions | RCSB PDB、AlphaFold DB、EMDB、IntAct、Complex Portal | 关闭 |
| Genes & Ontologies | MyGene.info、EBI OLS、QuickGO、Reactome | 关闭 |
| Genomes | Ensembl REST、UCSC Genome Browser | 关闭 |
| CellGuide | CELLxGENE CellGuide | 关闭 |
| Protein Annotation | InterPro、STRING v12、Human Protein Atlas | 关闭 |
| Omics Archives | NCBI GEO、PRIDE、MGnify、ArrayExpress、MetaboLights | 关闭 |
| Chemistry | PubChem、ChEBI、BindingDB、Rhea | 关闭 |
| Regulation | ENCODE、JASPAR、UniBind | 关闭 |
| BioMart | Ensembl BioMart | 关闭 |
| Drug Regulatory | openFDA、Drugs@FDA | 关闭 |
| Human Genetics | NHGRI-EBI GWAS Catalog、FinnGen PheWAS | 关闭 |
| Protein Records | UniProtKB | 关闭 |
| Nucleotide Archives | NCBI GenBank、ENA | 关闭 |
| Target Discovery | Open Targets Platform | 关闭 |
| ChEMBL | ChEMBL | 关闭 |

这些连接器共提供 89 个工具。可在 **设置 → MCP** 中仅启用需要的科研领域，查看已发现
工具、测试连接、筛选暴露的工具，并为工具选择 `询问`、`允许` 或 `拒绝`。内置连接器
定义只读；也可以注册自定义 `stdio`、Streamable HTTP、SSE 和 socket 连接器。连接器
设置全局生效，单个项目可以覆盖工具决策。配置变更会自动投影到活跃 Agent runtime，
无需手工编辑 Pi 配置文件。

连接器认证可引用托管密钥/令牌或具名环境变量，作为进程变量、HTTP Header 或 Bearer Token 传递。策略快照只含凭据引用，获准使用的凭据在 Worker 内存中解析。目前不支持 OAuth 登录与刷新。

`web_search` 和 `web_fetch` 是 Agent 内置工具，复用固定版本的 `pi-web-access@0.40.0` 核心。在**设置 → 联网搜索**中配置全局工具开关、搜索服务和 API Key。工具直接在可信 Worker 中执行，不经过代码执行沙箱，保留公网地址、重定向和响应体大小检查。Paper Search 继续作为学术数据库 MCP 连接器。详见 [Web Access 配置与验证](docs/web-access-mcp.md)。

## 科学文件查看器

Pi-Science 可以直接在浏览器中渲染常见科研格式。

| 领域 | 格式 | 查看器 |
|---|---|---|
| 化学 | CIF、PDB、PQR、SDF、MOL、MOL2、SMILES、XYZ、CUBE | 支持结构关联序列的 Mol* 交互式查看器 |
| 天文 | FITS | Canvas 渲染和科学色图 |
| 3D / CAD | STL、OBJ、PLY、glTF、GLB | Three.js 场景查看器 |
| 固体物理 | EIGENVAL、DOSCAR | 能带和态密度图 |
| 基因组 | BED、GFF、GTF、VCF | 轨道式基因组查看器 |
| 表格数据 | CSV、TSV | 可排序表格及折线、柱状、散点图 |
| 办公文档 | DOCX、XLSX、PPTX | 浏览器原生文档预览 |
| 通用格式 | Markdown、JSON、代码、图片、PDF、视频 | 语法感知或浏览器原生预览 |

## 系统架构

```mermaid
flowchart LR
    UI[浏览器] -->|REST / SSE v3| CP[Node 控制面]
    CP -->|IPC| W[Agent Core Workers]
    W --> H[AgentHarness / pi-ai]
    H --> S[(Core v4 会话)]
    CP --> K[Python / R 内核]
    CP --> M[记忆服务与后台任务]
    M --> DB[(SQLite state.sqlite)]
```

AgentHarness 管理智能体执行和持久操作状态。Node 控制面监督独立 Worker，将 Core 事实投影为有版本的浏览器协议，并协调科学计算服务。对话、标题、研究和子代理共用这套执行链路。Memory 的 Extraction/Dream 由控制面管理，使用独立且不带工具的模型调用。

Core 会话格式 **v4** 与产品 SSE 协议 **v3** 是独立版本。历史是 Core 会话的投影；旧格式只在数据读取/转换边界处理。SQLite 保存 Memory，并协调工作区、环境、任务和 MCP 策略，科研文件与产品元数据分别管理存储位置。

进程边界、事件交付、状态目录、恢复机制与能力隔离详见[架构文档](docs/architecture.zh-CN.md)。

## 斜杠命令

在对话输入框中输入 `/` 即可打开命令菜单。

| 命令 | 作用 |
|---|---|
| `/compact` | 压缩对话上下文 |
| `/export <html\|jsonl>` | 导出对话历史 |
| `/skill:<name>` | 调用动态发现的工作区技能 |

Pi-Science 托管的工作区默认信任 `.pi/skills/`；其中的项目内置 skills 会参与 Pi 的命令发现。可在 **设置 → Skills** 中查看和控制已发现的 skills。

## 执行证据

内核、Notebook 和智能体工具的执行都会记录在产生它们的对话会话中。执行状态会实时更新；在 Runs 视图中，可将执行定位到来源对话，也可打开该次执行生成的文件和产物。

对话 Worker 为文件型 `.ipynb` 提供 `notebook_read`、`notebook_edit` 和
`notebook_run`。`notebook_read` 会返回每个 cell 的 revision；默认编辑使用
Notebook 文件 SHA-256 做严格并发保护，也可用 `expected_cell_revisions`
只保护本次修改的 cell，使无关 cell 的并发修改不会阻塞操作。运行选定的
Python/R 代码块后，会把受限的执行次数、标准输出/错误、MIME 结果和错误输出
原子写回 Notebook，并返回新的 revision。产物发布失败会作为执行告警保留，
不会被静默忽略。

## 模型配置

可以在 **设置 → LLM** 中配置提供商。Pi-Science 支持内置厂商、OpenAI-compatible、Anthropic-compatible，以及 Ollama、LM Studio 等可信的无 Key 本地服务。还可以在同一页面注册、启停并检查托管模型端点。健康检查是带超时和响应大小限制的出站请求；为支持本地模型服务，默认允许私网端点，可通过 `PI_SCIENCE_ALLOW_PRIVATE_PROVIDERS=0` 禁用。

API Key 通过 **设置 → LLM** 管理。环境凭据需要在模型资源配置中明确引用变量名，仅导出厂商环境变量不会建立凭据绑定。

## AI 会话标题

成功完成一轮对话后，Pi-Science 可以生成 AI 标题（**默认启用**）。标题使用配置的**默认模型**，可能与当前对话模型不同。禁用工具与技能的临时 Worker 发送最近不超过 6 条消息，每条截断到 200 字符，并请求不超过 8 个词的标题。

这是一次额外的模型请求，会包含最近的对话片段。标题保存到项目实际元数据目录中的 `session-titles.jsonl`，浏览器存储作为即时回退。

如需禁用，请在启动前设置并重启服务：

```bash
export PI_SCIENCE_AI_TITLES=0
```

标题生成不阻塞对话，失败时保留侧边栏的派生名称。临时会话保持隐藏，在 Worker 释放时删除。

## 开发与测试

```bash
# JavaScript / TypeScript 测试
pnpm test

# 静态类型检查
pnpm typecheck

# 生产构建
pnpm build
```

补充端到端检查：

```bash
pnpm smoke
pnpm uat:conversation
pnpm smoke:agent-core
```

前端专项 UAT：

```bash
pnpm --filter frontend test:uat:memory
pnpm --filter frontend test:uat:notebook
pnpm --filter frontend test:uat:office
```

## 文档

| 内容 | 参考 |
| --- | --- |
| 进程边界、状态归属、事件与恢复 | [架构文档](docs/architecture.zh-CN.md) |
| 记忆设置、审核、召回、后台任务与数据保留 | [统一记忆](docs/unified-memory.md) |
| 支持的工具与已知限制 | [Agent Core 能力清单](docs/agent-core-capability-inventory.md) |
| 旧会话与离线转换 | [会话转换](docs/agent-core-session-conversion.md) |
| 科学连接器、凭据与工具策略 | [MCP 管理](docs/mcp-management-implementation.md) |
| 研究编排与确定性评估 | [对话原生 Auto Research](docs/auto-research.md) |
| 编写项目技能 | [技能编写](docs/skill-authoring.md) |

架构文档提供对应的实现记录链接，未提供双语版本的文档保留原语言。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请运行相关测试，以及 `pnpm typecheck` 和 `pnpm build`。修改运行时行为时，应同时补充回归测试。

## 许可证

MIT

可选的 [Pi 原生模型配置后端](docs/model-config-native.md) 支持版本化配置、显式凭证来源和保守的旧资源迁移。发布门槛通过前，部署默认仍为 `legacy`。
