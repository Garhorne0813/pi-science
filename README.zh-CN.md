# Pi-Science

**科学 AI 工作台**

Pi-Science 是一个基于 Web 的科学工作台。科学家可以在浏览器中与 AI 智能体对话、探索数据、编写分析代码、生成可视化结果，并追踪每个产物的完整谱系。

> English version: [README.md](README.md)

## 功能特色

### 智能体对话

核心界面是一个支持流式输出的科学对话工作区，AI 智能体可以实时编写、执行并可视化科学代码。

- **流式响应**：基于 SSE 的实时输出，每个工具调用都会显示为可展开卡片
- **LLM 提供商**：内置厂商目录，同时支持 OpenAI-compatible 和 Anthropic-compatible 自定义提供商
- **工具可视化**：文件写入、Shell 命令和代码执行会显示语法高亮及差异
- **Markdown 渲染**：支持表格、代码块、LaTeX 数学公式和文件路径识别
- **会话管理**：创建、恢复、分叉和删除会话；历史记录按工作区隔离
- **工作区指令**：每个工作区可以使用自动生成的 `AGENTS.md` 和 `KNOWLEDGE.md`
- **斜杠命令**：在输入框中输入 `/`，访问内置命令以及由技能和扩展注册的动态命令
- **交互式提示**：扩展发出的确认、选择、输入和编辑请求会以内联卡片呈现
- **可靠流式连接**：支持 SSE 断线重连、`Last-Event-ID` 补发，以及按工作区复用运行时

### 斜杠命令

在对话输入框中输入 `/` 即可打开命令菜单。内置命令直接执行界面操作，技能和扩展命令会转发给智能体。

| 命令 | 作用 |
|---|---|
| `/new` | 新建会话 |
| `/model <provider/model>` | 切换当前模型 |
| `/compact` | 手动压缩会话上下文 |
| `/name <name>` | 重命名当前会话 |
| `/copy` | 复制最近一条智能体回复 |
| `/export <html\|jsonl>` | 导出会话为 HTML 或 JSONL |
| `/session` | 显示会话信息和统计 |
| `/skill:<name>` | 通过智能体调用工作区技能 |

### 项目知识审稿人

每个工作区都有持续演化的 `PROJECT.md` 和由 Reviewer 管理的收件箱。系统会从对话和项目文件中识别有价值的知识，但只有用户确认后才会写入正式项目记录。

- **仅提案模式**：提取发现、结论、决策、假设、开放问题、任务、项目变更和产物
- **证据链接**：提案保留来源会话、消息 ID、相关文件、置信度和冲突信息
- **人工审批**：用户可以接受、编辑、拒绝或批量审核提案
- **自动或手动审稿**：会话稳定后自动运行，也可以在输入框中手动触发 Review
- **混合文件组织**：物理目录保持浅层，同时提供按类型、主题和时间的逻辑视图
- **安全文件计划**：预览移动/重命名，检测冲突和引用，事务化执行，并支持撤销
- **项目版本**：每次审核后的项目文档更新都会生成可恢复版本
- **项目策略**：支持锁定路径、设置命名约定，并根据审核结果调整策略

工作区知识数据存储在 `.pi-science/knowledge/`、`.pi-science/inbox/`、`.pi-science/history/`、`.pi-science/index.json` 和 `.pi-science/policy.yaml`。

### 科学文件查看器

Pi-Science 在浏览器中原生渲染多种科学和办公格式，无需额外插件。

| 类别 | 格式 | 渲染方式 |
|---|---|---|
| 天文 | FITS | Canvas 与 magma、viridis、gray 等色图 |
| 化学 | CIF、PDB、SDF、MOL、SMILES、XYZ | 3Dmol.js WebGL，可旋转、缩放、测量 |
| 3D / CAD | STL、OBJ、PLY、glTF、GLB | Three.js WebGL，可轨道旋转、平移、线框显示 |
| 固体物理 | EIGENVAL、DOSCAR | SVG 能带结构和态密度图 |
| 相图 | JSON 相数据 | 凸包分析和相标签 |
| 基因组 | BED、GFF、GTF、VCF | Canvas 基因组浏览器和注释轨道 |
| 表格数据 | CSV、TSV | 可排序 HTML 表格和 SVG 折线/柱状/散点图 |
| 办公文档 | DOCX、XLSX、PPTX | 原生 JavaScript 渲染器，无需 Office |
| 代码 | Python、R、Bash、Markdown、JSON | highlight.js 语法高亮 |
| 图片和媒体 | PNG、JPEG、GIF、SVG、PDF、MP4 | `<img>`、`<iframe>`、`<video>` 原生预览 |

### 文件浏览器

持久化侧边栏镜像当前工作区目录，无需离开对话即可浏览、预览和管理文件。

- 点击文件在右侧检查器中预览
- 右键菜单支持复制名称、复制路径和删除
- 支持拖放上传文件到工作区
- Files 页面提供面包屑导航和更完整的文件浏览

### 检查器面板

右侧检查器会根据当前选择切换文件预览、谱系历史或 Notebook 视图。

- **文件预览**：代码、表格、分子、FITS、基因组轨道等
- **HTML 预览**：支持带外部 CSS 的 HTML 产物，同时限制预览范围在当前工作区内
- **版本历史**：查看写入者模型、使用的工具、完整代码或差异
- **Notebook**：通过 Python/R 内核使用单元格进行交互式探索

### 谱系追踪

智能体创建或修改的每个文件都会自动记录完整谱系。可以在文件预览中的历史入口查看：

- **工具和模型**：哪个工具、哪个模型生成了文件
- **代码和差异**：生成代码或编辑差异
- **环境快照**：Python 版本、平台和依赖锁定信息
- **复现**：一键生成复现提示并比较结果
- **会话链接**：跳转到产生该文件的原始会话

### 计算与实验

- **Python / R 内核**：按 Notebook 持久化、隔离的执行会话
- **技能验证与复现**：验证技能元数据、运行触发样例、发布带哈希的产物，并记录会话技能快照
- **Jupyter Lab**：在 Notebooks 页面一键启动/停止
- **大文件探测**：对 CSV、NetCDF、FITS、Parquet、STL 和基因组文件检测结构，不必完整加载
- **实验运行**：记录命令、输出、状态、主机、取消、超时和日志

### 扩展

| 扩展 | 作用 |
|---|---|
| `pi-mcp-adapter` | 连接 MCP 服务器，访问 PubMed、arXiv、生物医学、材料数据库和天气数据 |
| `pi-subagents` | 编排 scout、researcher、planner、worker、reviewer、oracle 等子智能体 |
| `pi-web-access` | 网页搜索、URL 获取和 YouTube/视频理解 |
| `context-mode` | 沙箱代码执行（12 种语言）与长会话 FTS5 知识索引 |

### 技能驱动的科研运行时

技能是经过 YAML 元数据验证的能力包，而不是孤立的提示词文件。工作台会记录每个会话加载的技能摘要，为用户可见产物保存内容哈希和验证状态，并提供文献、PDF 页码索引、MCP 目录、任务、结果审查和转录书签 API。

详见 [docs/skill-schema.md](docs/skill-schema.md) 和 [docs/science-platform-runtime.md](docs/science-platform-runtime.md)。

### 工作区

- **Projects 页面**：以卡片展示工作区，可创建、打开或删除项目目录
- **会话隔离**：每个工作区拥有独立的 `.pi-science/`，保存会话、谱系和实验运行数据
- **按工作区配置**：不同项目可以使用不同的 API Key、模型和 MCP 服务
- **安全边界**：工作区容器根目录不会被当作项目；启动扫描只登记带 `.pi-science` 标记的子工作区

### LLM 提供商配置

Settings → LLM 将模型选择和提供商配置分开：

- **Default Model**：从已配置提供商暴露的模型中选择默认模型
- **Thinking Level**：根据当前模型能力动态显示可用推理等级，不支持的等级不会出现
- **Model Vendors**：配置 Anthropic、OpenAI、Google、DeepSeek、Groq、OpenRouter、Mistral、Z.AI、MiniMax 等内置厂商
- **Custom**：发现 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 端点的模型
- **Managed Model Endpoints**：作为高级集成注册本地或远程模型服务

API Key 保存在 Pi-Science 配置目录中。自定义提供商与内置厂商分开管理，因此默认模型列表更容易理解。

### 主题与国际化

- **暖纸张视觉**：奶油色背景、柔和阴影和衬线标题；支持暗色模式
- **中英文界面**：默认英文，可在 Settings → General 切换简体中文
- **可调整面板**：支持拖动调整侧栏、检查器和输入框宽度

## 页面与路由

| 页面 | 路由 | 用途 |
|---|---|---|
| Projects | `/` | 创建、打开或删除工作区 |
| Workspace | `/workspace/:cwd` | 打开项目并恢复或创建会话 |
| Chat | `/workspace/:cwd/session/:sessionId` | 智能体对话、工具卡片和文件预览 |
| Files | `/workspace/:cwd/files` | 完整文件浏览、面包屑和表格/图表视图 |
| Notebooks | `/workspace/:cwd/notebooks` | 运行 `.ipynb` 文件和管理 Jupyter Lab |
| Runs | `/workspace/:cwd/runs` | 查看实验命令、状态、主机和输出 |
| Project Knowledge | `/workspace/:cwd/knowledge` | 审核提案、查看 `PROJECT.md`、管理逻辑文件 |
| Skills | `/skills` | 查看已安装技能和科学工具 |
| Settings | `/settings` | 配置 LLM、提供商、扩展和 MCP |

## 快速开始

### 前置条件

- Python 3.11+ 和 `pip`（Conda 可选）
- Node.js 22+
- 一个 LLM API Key，例如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`

### 一键启动

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
bash scripts/dev.sh
```

启动脚本会准备运行时和依赖，并启动：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`
- API 文档：`http://127.0.0.1:8787/docs`

启动后进入 Settings → LLM 配置提供商 Key，即可开始对话。Jupyter Lab 是可选组件；如果需要单独的“打开 Jupyter Lab”按钮，可以执行 `python -m pip install jupyterlab`。

### 配置 API Key

可以在 Settings → LLM 页面配置，也可以使用环境变量：

```bash
export DEEPSEEK_API_KEY=sk-...
# 或 ANTHROPIC_API_KEY、OPENAI_API_KEY
```

## 开发检查

```bash
cd backend && uv run pytest -q
cd frontend && npm test -- --run
cd frontend && npm run build
```

前端还提供专项 UAT 脚本：

```bash
cd frontend
npm run test:uat:conversation
npm run test:uat:knowledge
npm run test:uat:notebook
npm run test:uat:office
```

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | React 19、TypeScript 6、Vite 8、Tailwind CSS 3、Zustand 5、React Router 7 |
| 后端 | Python 3.11+、FastAPI、Uvicorn、Pydantic、sse-starlette |
| 智能体运行时 | pi（Node.js，基于 stdin/stdout 的 JSONL RPC） |
| 3D | Three.js、3Dmol.js |
| 化学 | OpenChemLib |
| 文档 | docx-preview、ExcelJS、pptx-preview |
| 代码 | highlight.js |
| 字体 | Inter、Source Serif 4、JetBrains Mono |

## 许可证

MIT
