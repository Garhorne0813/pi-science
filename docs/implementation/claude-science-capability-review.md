# Claude 科学能力调研报告

> 范围：A（Claude Code 生态：Skills/MCP/插件/子代理）+ C（Anthropic 科学能力/数据/API）
> 素材：scout + 2× researcher + 2× planner + 1× reviewer + 1× oracle + 用户修改意见 + 1× 聚焦复审（v3）→ v4 用户决定：文档技能暂缓
> 来源标注：🏛️官方 / 👥社区 / ❓未验证

## 0. 前置决策（已定）

**数据外发契约（决策 A 细化）**：维持 README 严格承诺，但连接器**不默认关闭**——文献/数据连接器默认可用，所有外发请求进 egress 审计；Node 控制面在发起外发前对搜索词做**敏感模式检测**（DNA/蛋白序列模式、化合物标识、患者/临床标识、内部项目名等），命中则**询问用户确认后再查询**，未命中直接放行。UI 明示每个连接器的外发目标。

**实施前提（聚焦复审 M1/m5 修订）**：查询必须经 **Pi 会话内工具执行**（agent 发起 → Node 文献服务执行），因为问卷机制是 agent 工具（`ask_user_question`，`pi-science-ask-user-question-web.ts:233-246`），**Node 无法直接触发**（pi-process.ts RPC 面无发起询问命令）。链路：Node 检测敏感词 → **拒绝外发**并返回 tool result「命中敏感词，请先征得用户同意再重试」→ agent 调用问卷 → 用户批准（批准记录 + 短时批准 token 存 Node）→ 重试时凭批准放行。**Node 侧硬闸门：无批准记录拒绝 fetch**；询问是软闸门，硬闸门与 egress 审计兜底。若未来暴露纯 HTTP 检索 API（不经 agent 会话），需另建确认通道（新 SSE 事件 + 端点 + 对话框），不在本期范围。

## 1. 结论摘要

pi-science 与 Anthropic 科学产品定位高度重叠，差异优势在本地优先 + 可复现性。最高性价比三件事：

1. **文献/数据检索服务端化（四件套全上）**：arXiv、PubMed/NCBI E-utilities（含 GenBank）、PubChem、UniProt 全部接入 Node 控制面（缓存/去重/限速/审计/敏感词询问）
2. **SKILL.md 规范对齐 + 移植 2 个已核实许可证的官方/社区技能**
3. **用官方基准建立本地评测**（BioMysteryBench-preview 仅 5 题预览，规模受限，需注明）

## 2. 项目现状要点（scout 盘点）

- `skills/` 10 个技能，统一 SKILL.md + frontmatter；仅 literature-review 有 vitest；**`test:skills` 只运行 literature-review 一个目录**
- 平台：Python kernel、research loop（预算/暂停/快照 sha256）、provenance（sha256+环境指纹）、MCP 支持（stdio/http，pi-mcp-adapter 桥接）、project registry、memory ledger、Pi web 宿主
- 空白/风险点：
  - 文献检索无服务端实现（全靠 skill 内 curl）
  - MCP health 恒 "unknown"、egress 仅警示文案无数据面拦截；`validateOutboundHttpUrl` 未覆盖 MCP/skill 内 curl（SSRF 面）
  - **`seedWorkspaceAssets()` 只复制 SKILL.md**（移植带脚本的技能会缺文件）
  - **`packages/contracts` 将缺失 license 默认成 Apache-2.0**
  - Compute/SSH 有 catalog 未接线；R kernel 存在但前端未暴露
  - Inspector 已有 `OfficePreview`（docx/xlsx/pptx 只读预览），**无编辑能力**；workspace 文件写回通道存在（file-routes）

## 3. 候选能力清单

### 3.0 前置门槛（P0 第一批，任何外部集成前必须完成）

| # | 门槛 | 要点 |
|---|------|------|
| G1 | 第三方资产 admission 流程 | 每项记录：仓库 URL、固定版本/commit、license（逐目录核实）、维护状态、启动命令、网络目标、认证方式、外发类别 |
| G2 | 外发安全与可观测 | health 真探测（stdio 查可执行文件/env、HTTP 查 URL 认证，不做昂贵查询）；egress 升级为审计记录；敏感词检测 + 询问确认机制（§0）；SSRF 防护覆盖连接器与 skill 内 curl（私网/重定向/DNS rebinding） |
| G3 | 修复技能基建 | seedWorkspaceAssets 安全复制整个技能目录（拒符号链接/路径逃逸/清理过期 seed）；license 缺失不再默认 Apache-2.0；`test:skills` 覆盖全部 `skills/*/tests/*.test.ts` |

### 3.1 可直接移植（P0/P1）

| # | 候选 | 来源 | 理由/调整 |
|---|------|------|----------|
| 1 | **文献/数据检索服务端化四件套全上**：① PubMed/NCBI E-utilities（**含 GenBank**）② arXiv ③ PubChem ④ UniProt | 🏛️ NCBI E-utilities / arXiv API / PubChem REST / UniProt REST（均为官方 API） | **四件套均为 P0 交付（无试点阶段）**；按 ①→②→③→④ 分批发布仅为可回滚节奏；Node 控制面统一缓存/去重/限速/审计 + provenance 快照（检索时间、响应 hash、稳定标识符）；**不采用 GSA-TTS/mcp-server-ncbi-eutils（0 stars 无 license），直接封装官方 E-utilities** |
| 2 | life-sciences 官方 skills 移植 2 个：scientific-problem-selection（文本型）、single-cell-rna-qc（依赖可控） | 🏛️ anthropics/life-sciences | 先过 license 审计；Nextflow/Allotrope 第二波单独审批（重型依赖） |
| 3 | SKILL.md 规范对齐：互操作核心字段（name/description）+ 保留 pi 扩展字段（category/requirements/risk/third_party）；progressive disclosure 行为测试 | 🏛️ agentskills.io + 👥 convert.sh CI 模式 | 技能生态互通 + 规避全量加载 token 膨胀（Claude issue #15662） |
| 4 | 统计分析与数据清洗技能（两遍式「生成→批判校验」工作流） | 👥 mcpmarket skills | SKILL.md+Python 同构，高频场景，license 核实后移植 |
| 5 | LaTeX/tectonic PDF 生成技能 | 👥 社区 | 本地二进制离线可用 |
| 6 | 评测基线：BioMysteryBench-preview（5 题预览）+ 独立评测工程（pin revision/hash，CI 只跑离线 smoke） | 🏛️ HF Anthropic/BioMysteryBench-preview | 评测 research loop 与 notebook 执行链 |

### 3.2 需适配（中优先）

| # | 候选 | 来源 | 理由 |
|---|------|------|------|
| ~~7~~ | ~~文档技能（docx/pptx/xlsx 生成/解析/预览编辑）~~ | — | **已暂缓，本期不做**（用户决定）。调研结论留档：微软无文档生成类官方 skill（microsoft/skills 为 MIT 但无文档类；markitdown MIT 仅解析）；anthropics/skills 文档技能为 **Proprietary**（LICENSE.txt 禁止复制/衍生/分发，且为 Node+docx-js+pandoc 栈），不可入库；如未来重启，推荐路径：python-docx/python-pptx/openpyxl（均 MIT，社区标准）自研 + 结构化源编辑再生模式 |
| 8 | ALKYL（RDKit）、fundamental-physics marketplace | 👥 社区 | 领域契合但重型依赖，需环境就绪检测 + license 审计 |
| 9 | skill-development 元技能 → 技能作者指南（应用内自产技能） | 🏛️ anthropics/claude-code plugins | 与 G3 规范对齐配套 |
| 10 | 图表读取防幻觉双通道（提取值 + 程序化校验对照源 CSV） | 👥 ChartQAPro 基准 | 该基准显示复杂图表精度衰减；写入图表分析 skill 设计 |

### 3.3 暂缓项（P2 及以后，本阶段不排期）

| # | 候选 | 说明 |
|---|------|------|
| 11 | 子代理编排模式升级（并行分支/限额/摘要回传） | 架构演进，暂缓 |
| 12 | 插件打包/技能市场 | 排在信任/签名/egress 审计之后，暂缓 |
| 13 | Sequential Thinking MCP | 暂缓 |
| 14 | Claude prompt caching + Batch API | 暂缓（依赖上游支持确认） |
| 15 | Claude Science 工作台差距对照实施（远程计算 SSH/HPC/Modal） | 方向参照保留，实施暂缓 |
| 16 | 合规开关（ZDR/BAA/HIPAA） | 合同/部署条件，暂缓 |
| 17 | 沙箱运行 profile 精调 | 暂缓 |

## 4. 差距对照（Claude Science 工作台 vs pi-science）

> ⚠️ Claude Science 列细节据社区报道（MIT Tech Review 2026-06、coursiv），官方新闻页未直接抓取成功（反爬），仅作方向参照。

| 维度 | Claude Science | pi-science | 差距 |
|------|---------------|-----------|------|
| 本地代码执行 | Python/R | Python kernel（R 桥存在前端未暴露） | 小 |
| Artifact 溯源 | code+env+conversation+review | sha256+provenance+project-review | 小 |
| 数据连接器 | PubMed/Open Targets/ChEMBL/ClinicalTrials/Synapse/Benchling/10x | 无（skill 内 curl） | **大**（P0：四件套） |
| 远程计算 | SSH/HPC/Modal | catalog 有 /api/compute 未接线 | 大（暂缓） |
| 评测 | — | 无 | 中（P1） |
| 合规 | HIPAA/BAA | 无 | 中（暂缓） |

## 5. 路线图（P2 暂缓，只排 P0/P1）

- **P0 前置门槛（G1-G3）**：admission/license 审计、外发安全（health 真探测/egress 审计/敏感词询问/SSRF 防护）、技能基建修复（seed 全目录/license 默认值/test:skills 范围）
- **P0**：文献/数据检索服务端化——四件套分批发（① PubMed/NCBI+GenBank → ② arXiv → ③ PubChem → ④ UniProt），每批发一个独立可回滚批次；SKILL.md 规范对齐
- **P1**：life-sciences 2 个技能移植（环境 preflight、fixtures、provenance 断言）；BioMysteryBench 离线评测工程（CI 只跑 smoke）；统计/清洗或 LaTeX 技能（文档技能已暂缓，OfficePreview 保持现状）

## 6. 风险与未验证项（❓）

1. **license**：anthropics/skills license 元数据为 null；claude-cookbooks 实为 MIT（已核实）；文档技能 source-available/Proprietary 不可复制（已暂缓规避）；life-sciences 各 skill 须逐目录核实
2. **社区 MCP 活跃度**：GSA-TTS/mcp-server-ncbi-eutils 0 stars 无 license（已排除，用官方 API）；PubChem/UniProt 社区实现仅作参考，优先官方 REST API
3. **数据驻留**：官方隐私文档抓取失败（404/反爬），EU/中国数据驻留细节未验证；UI 不得提前作合规保证
4. **敏感词检测边界**：模式匹配存在误报/漏报；询问是软闸门（批准经 agent 转述，对抗性 agent 可伪造）——**硬闸门在 Node：无批准记录拒绝外发** + 短时批准 token + egress 审计始终记录；词表/规则需随使用迭代
5. **Pi 能力前置**：pi-mcp-adapter 实际读取配置路径与 catalog API 一致性未验证（需 characterization test）；prompt caching 依赖上游（已暂缓）
6. **评测规模**：BioMysteryBench-preview 仅 5 题；谱图/显微图多模态无官方量化评测（自建小基准）
7. **工程前置**：seedWorkspaceAssets 只复制 SKILL.md（blocker，G3 修复）；contracts 缺 license 默认 Apache-2.0
8. **执行轮次预算**（planner B）：文献检索 L=2 worker 隔离 worktree/3 轮（四件套分 4 批各 M）；技能规范 M=1/2-3 轮；life-sciences 每批 M=1/2 轮；评测 M=1/2-3 轮（文档技能已暂缓，不计入）

> **注记（2026-08-03）**：BioMysteryBench 评测工程已移出本仓库至 `../biomysterybench-evals`（用户决定暂不继续评测；工程保留完整，含 full 数据集支持与 58 个离线测试）。本报告 §3.1#6 / §5 P1 中的评测项相应暂缓。
