# Pi-Science

**科学 AI 工作台**

Pi-Science 是一个基于 Web 的科研工作台。科学家可以在同一个工作区中与 AI 智能体对话、探索数据、编写分析代码、生成可视化结果，并追踪所有产物的来源谱系。

> English version: [README.md](README.md)

## 功能特色

- **智能体对话**：流式响应、工具调用卡片、Markdown/LaTeX 渲染、会话创建/恢复/分叉/删除、斜杠命令、交互式确认，以及断线重连。
- **项目知识审稿**：提案式审稿、证据链接、人工确认、版本化 `PROJECT.md`、安全文件计划、事务性移动、撤销和项目策略。
- **科学文件查看器**：支持 FITS、CIF、PDB、SDF、MOL、SMILES、XYZ、STL、OBJ、PLY、glTF、EIGENVAL、DOSCAR、相图、基因组格式、CSV/TSV、DOCX/XLSX/PPTX、代码、图片、PDF 和视频。
- **谱系追踪**：记录智能体使用的工具、模型、生成代码/差异、环境快照、复现提示词和来源会话。
- **计算能力**：Python/R 内核、Jupyter Lab、实验运行记录、大文件探测、计算需求、本地任务、取消、超时和日志。
- **技能驱动运行时**：YAML 技能校验、来源优先级、会话快照、触发器 fixture、哈希产物，以及文献/PDF/MCP/任务/审稿/书签 API 和提示词注入检测。详见 [docs/skill-schema.md](docs/skill-schema.md) 与 [docs/science-platform-runtime.md](docs/science-platform-runtime.md)。
- **扩展系统**：MCP 桥接、多智能体子代理、Web 访问，以及带 FTS5 知识索引的 context-mode 沙箱执行。
- **工作区隔离**：每个工作区独立保存会话、谱系、运行记录、配置，并进行路径安全校验。
- **国际化**：默认显示英文，可在“设置 → 常规”切换简体中文。

## 页面

| 页面 | 路由 | 用途 |
|---|---|---|
| 项目 | `/` | 创建、打开或删除工作区 |
| 工作区 / 对话 | `/workspace/:cwd` | 恢复或创建会话 |
| 文件 | `/workspace/:cwd/files` | 浏览和预览工作区文件 |
| 笔记本 | `/workspace/:cwd/notebooks` | 运行笔记本并管理 Jupyter Lab |
| 运行记录 | `/workspace/:cwd/runs` | 查看实验历史 |
| 项目知识 | `/workspace/:cwd/knowledge` | 审核提案和项目记录 |
| 技能 | `/skills` | 查看已安装技能和科研工具 |
| 设置 | `/settings` | 配置模型、扩展和 MCP |

## 快速开始

### 前置条件

- Python 3.11+ 和 `pip`（Conda 可选）
- Node.js 22+
- 一个 LLM API Key，例如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`

```bash
git clone https://github.com/Garhorne0813/pi-science.git
cd pi-science
bash scripts/dev.sh
```

开发脚本会启动：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`
- API 文档：`http://127.0.0.1:8787/docs`

然后打开“设置 → LLM”填写模型服务商的 Key。Jupyter Lab 是可选组件；如需使用独立的 Jupyter 按钮，可执行 `python -m pip install jupyterlab`。

## 开发检查

```bash
cd backend && uv run pytest -q
cd frontend && npm test -- --run
cd frontend && npm run build
```

浏览器 UAT 脚本包括：`npm run test:uat:knowledge`、`test:uat:notebook`、`test:uat:office` 和 `test:uat:conversation`。

## 技术栈

React 19 · TypeScript 6 · Vite 8 · Tailwind CSS · Zustand · FastAPI · Uvicorn · Pydantic · SSE · Three.js · 3Dmol.js · OpenChemLib

## 许可证

MIT
