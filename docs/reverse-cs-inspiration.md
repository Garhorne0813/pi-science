# reverse_cs 对本项目的启发 —— 从"科研聊天工作台"到"可审计的科研项目系统"

> 范围说明：本文基于对 `/Users/cyq/pi/reverse_cs`（Claude Science 构建产物的静态提取；构建带 `-dev` 版本标签，属 public/external release，详见第 2 节）的只读分析，与本项目（Pi-Science）现状对比后形成的建议。文中所有涉及 reverse_cs 的路径均指 `~/pi/reverse_cs/analysis/extracted/` 下的提取产物。

## 1. 摘要

Pi-Science 与 reverse_cs 在基础架构上已经相当接近：React UI → Node 控制面 → Python 科学运行时的三进程边界、Artifact 元数据与 provenance、Research Loop、官方科学数据网关、完整的安全的 skill-tree seeding 均已存在。

真正值得借鉴的不是继续堆工具、Skills 或 MCP，而是**把科研过程进一步产品化为"可导航、可恢复、可审计的项目系统"**：

1. 从"文件预览"升级到 **Artifact Library 与版本级 DAG**；
2. 为长科研会话增加**书签、阅读位置与 Attention Queue**；
3. 把 Skills 从"指导文档"升级为**可恢复的科学 SOP**；
4. 将后台角色拆成**窄权限角色**（已观察：reviewer 只追踪、bookmarker 只选 span；Executor / Memory proposer / Compute worker 为本项目提议的权限抽象，见 4.4）；
5. 将远程计算从"SSH 设置"做成**完整 Job Lifecycle**。

## 2. 范围与证据前提

- reverse_cs 是 Claude Science 构建产物的**静态提取**：`assets/BUILD.json` 显示 flavor=release、channel=public、user_type=external，版本标签为 `0.1.15-dev…`（即带 `-dev` 标签的 public/external release，而非泛称“开发版”）。原始 minified Bun bundle 经美化后约 **433,812 行**（`claude-science`），另有 SQLite schema 与资产文件。部分能力可能未在产物中启用或未完整暴露，因此本文借鉴的是其**产品模式与数据契约**，不将其当作可直接复制的实现。
- 具体地，routines（定时任务）虽然存在 `routine_schedules` 表（`assets/drizzle/sqlite/` 内）与 5–1440 分钟间隔配置，但提取版中 `isRoutine()` 固定返回 `false`、`tickRoutine()` 返回 `null`（`claude-science` 二进制约 190040、309877 行处），即**scheduled agent 只是潜在设计，不是已验证的活跃工作流**。
- 许可边界：提取产物中 29 个顶层 `SKILL.md` 均声明 `license: Apache-2.0`，但该声明**不应被推定覆盖**整个应用 bundle、SQLite schema、内部 prompt 或 UI 代码。本文仅借鉴通用产品模式、科学工作流原则与数据契约思想；任何具体代码、文案或资源的复用，均需单独核查许可证与 attribution/NOTICE 要求，并检查第三方模型权重与服务许可。
- 本文引用本项目路径时，以当前代码为准（如 `apps/server/src/literature/*`、`apps/server/src/runtime/pi/pi-runtime-launch.ts`），不沿用旧版 capability review 中已过时的结论。

## 3. 现状对照：Pi-Science 已接近的部分

以下能力已存在，无需重做底层架构：

| 能力 | 本项目位置 |
| --- | --- |
| React/Node/Python 三进程边界 | `docs/architecture.zh-CN.md` |
| Artifact 版本、哈希、producer、inputs、环境、验证与 provenance（服务端） | `apps/server/src/http/routes/artifact-routes.ts` |
| Artifact 与 provenance 展示（前端） | `frontend/src/components/inspector/ArtifactInspector.tsx`、`frontend/src/components/inspector/ProvenancePanel.tsx`、`frontend/src/components/inspector/FilePreviewInspector.tsx` |
| 对话内产物展示与跨重载恢复 | `frontend/src/components/conversation/TurnArtifactStrip.tsx`、`apps/server/src/runtime/artifacts/turn-artifact-repository.ts` |
| Research Loop 持久事件、预算、暂停恢复、计划步骤与人工确认 | `docs/adr-research-loop-subagents.md`、`frontend/src/components/conversation/ResearchLoopControls.tsx` |
| 官方科学数据网关（PubMed/GenBank/arXiv/PubChem/UniProt）+ 敏感查询确认 + SSRF 防护 + egress 审计 | `apps/server/src/literature/providers.ts`、`apps/server/src/literature/literature-service.ts`、`apps/server/src/security/outbound-security.ts`、`apps/server/src/security/egress-audit.ts` |
| 完整、安全的 skill-tree seeding（helper/references/assets，而非仅复制 SKILL.md） | `apps/server/src/runtime/pi/pi-runtime-launch.ts` |
| 长期项目知识（Memory Ledger） | `apps/server/src/memory/ledger.ts` |
| 计算设置与探测面 | `frontend/src/components/settings/ComputeSettings.tsx`、`apps/server/src/http/routes/catalog-routes.ts` |

因此差距主要不在"有没有能力"，而在**这些能力是否形成统一、清晰的科研产品体验**。

## 4. 五大启发

### 4.1 从"文件预览"升级到 Artifact Library 与版本级 DAG（战略基础）

Claude Science 不把 artifact 仅视为生成的文件，而是区分：

- 逻辑 artifact 与不可变版本；
- 具体 producing cell；
- 输入 artifact 版本；
- environment snapshot；
- parent/superseded 版本；
- intermediate 与正式交付物；
- review、annotation 与 lineage。

核心模型见：

- `analysis/extracted/assets/drizzle/sqlite/0000_yummy_ken_ellis.sql`
- `analysis/extracted/assets/drizzle/sqlite/0005_execution_log.sql`
- `analysis/extracted/assets/web-dist/assets/ProvenancePane-DibqtOdI.js`

本项目已具备 `artifact_id + 不可变 version`，但当前 `artifact_id` 由 `sha256(cwd + ":" + relativePath)` 派生（`apps/server/src/http/routes/artifact-routes.ts`），即**身份与文件路径耦合**：文件重命名或移动后重新发布会得到新的 artifact_id，跨移动追踪版本历史不便。建议在此基础上引入**独立于路径的稳定逻辑身份**，并增加结构化关系：

```text
derived_from
supersedes
consumes
produced_by
reviewed_by
```

Inspector 进一步显示：由哪些输入版本产生、由哪段代码/哪个 run/哪个环境生成、被哪些下游结果消费、是否已被更新版本取代、属于中间结果还是正式交付物。最终形成**项目级 Artifact Library**，而不只是在每轮对话下方展示文件卡片。

### 4.2 为长科研会话增加书签、阅读位置与 Attention Queue

reverse_cs 提供以下与长会话导航相关的已观察能力（对"100 轮后找回结论"这类场景可能有实际帮助）：

- agent 自动 Bookmarker；
- 用户与 agent 的 transcript annotations；
- read cursor；
- seen/unseen 状态；
- message 精确跳转；
- "Needs you / Plan ready / Running / Completed"注意力队列（Completed 支持 seen/unseen 区分）。

相关实现：

- `analysis/extracted/assets/agents/bookmarker/metadata.yaml`
- `analysis/extracted/assets/drizzle/sqlite/0038_transcript_annotations.sql`
- `analysis/extracted/assets/drizzle/sqlite/0055_frame_read_cursors.sql`
- `analysis/extracted/assets/web-dist/assets/ProjectDashboard-yMcbMcpO.js`
- `analysis/extracted/assets/web-dist/assets/FindingRow-NhgHKJiW.js`（review finding 展示位于会话/消息视图，而非 Dashboard）

本项目的 Memory Ledger（`apps/server/src/memory/ledger.ts`）适合保存长期项目知识，但"项目长期知识"与"这个会话的重要结果在哪、我上次读到哪里"是两个需求。建议增加轻量会话导航层：用户手工书签、自动 bookmark 作为提案由用户接受、书签锚定 message ID/block/原文 span、恢复上次阅读位置。reverse_cs 的 ProjectDashboard 已覆盖等待输入/计划待批准/运行中/未读完成状态；将未解决 review finding 纳入 Attention Queue 属于对本项目的**扩展建议**。相较完整 Artifact DAG，这可能是范围更易收敛的切入点；实际成本与用户收益仍需通过小型技术方案与 UAT 验证。

### 4.3 把 Skills 从"指导文档"升级为可恢复的科学 SOP

reverse_cs 中最有价值的不是 Skill 数量，而是部分 Skill 的工作流深度：

- `indication-dossier` 把长调研拆成多个阶段，每阶段产出 schema 化 waypoint 并规定恢复逻辑：
  - `analysis/extracted/assets/skills/indication-dossier/SKILL.md`
  - `analysis/extracted/assets/skills/indication-dossier/references/waypoint-schemas.md`
  - 其 references 目录还包含 research standards、meta-initialization、各领域研究方法、synthesis 与 writing-style 的分层文档。
- `figure-composer` 不是"生成一张漂亮图片"，而是：定义 claim 与多 panel 布局 → 独立生成 panel → 合图 → visual QA → 对抗式 review → 只重做有问题的 panel → 设置最大收敛轮数：
  - `analysis/extracted/assets/skills/figure-composer/SKILL.md`
  - `analysis/extracted/assets/skills/paper-narrative/SKILL.md`

建议不优先新增几十个 Skill，而是挑 2–3 个核心 Skill（`literature-review`、`figure-composer`、`traceability-review`）做深，每个深 Skill 至少包含：明确输入/输出 schema、阶段性 artifact、可恢复 checkpoint、人工确认点、科学有效性条件、常见失败模式、收敛与停止条件、characterization/eval 测试。本项目的 Research Loop（durable events、预算、恢复）可复用于 systematic review、dataset QC、reproduction package、manuscript revision 等非优化型流程。

### 4.4 窄权限角色：reverse_cs 的已观察角色与本项目提议的权限抽象

reverse_cs 提取产物中可观察到的命名 agent 为 **OPERON（通用执行 agent）**、**reviewer**、**bookmarker** 与 **onboarding**：

- **OPERON**：主 agent，负责执行、workspace 操作与产物生成；
- **Reviewer**：只追踪证据与矛盾，不重新计算（"Trace, don't recompute"）；
- **Bookmarker**：只选择值得回看的原文 span；
- **onboarding**：新用户引导。

相关实现：

- `analysis/extracted/assets/agents/operon/metadata.yaml`
- `analysis/extracted/assets/agents/reviewer/metadata.yaml`
- `analysis/extracted/assets/agents/bookmarker/metadata.yaml`
- `analysis/extracted/assets/agents/onboarding/metadata.yaml`
- `analysis/extracted/assets/drizzle/sqlite/0029_verification.sql`

关于记忆权限需要澄清：reverse_cs **并非**"记忆只提案、等批准"——OPERON 可通过 `write_memory` 直接修改持久记忆，后台 memory-extraction pass 也会调用 `emit_memories` 一次性执行 append/replace/remove（写入带 evidence 等溯源字段），没有 proposal 审批门。反而是本项目 Memory Ledger（`apps/server/src/memory/ledger.ts`）已经具备 `pending/accepted/rejected/superseded` 状态、`ApprovalRequirement` 与 proposal → accepted record 的部分实现。建议在此基础上继续坚持"agent 只提交候选、Node 控制面接受"的更严格边界，并将现有 proposal/approval 语义扩展为 runtime 强制的角色权限，而非从零新建 Memory Proposer。

下表是针对 Pi-Science **提议**的权限角色抽象（不完全对应 reverse_cs 的命名 agent），建议由 Node/Pi runtime **强制**（而非只写在 prompt 中）：

| 角色 | 应允许 | 不应允许 |
| --- | --- | --- |
| Reviewer | 读取 transcript、artifact、execution log | 写文件、重跑分析 |
| Bookmarker | 提交 message span | 修改 transcript、保存 memory |
| Memory proposer | 提交带 evidence 的候选记忆 | 直接接受为项目记忆 |
| Executor（对应 OPERON 执行职责的抽象） | 经授权执行和写 workspace | 绕过 Node 网络与路径安全 |
| Compute worker | 访问声明的 inputs/outputs | 任意访问 workspace |

### 4.5 将远程计算从"SSH 设置"做成完整 Job Lifecycle

reverse_cs 把远程计算统一为：

```text
stage inputs
→ submit
→ stream logs
→ status/reconcile
→ cancel
→ harvest outputs
→ publish artifact
→ attach provenance
```

相关模型：

- `analysis/extracted/assets/compute/operon_compute_provider/__init__.py`
- `analysis/extracted/assets/compute/run.sh.tmpl`、`analysis/extracted/assets/compute/wrapper.sh.tmpl`
- `analysis/extracted/assets/agents/operon/metadata.yaml`
- `analysis/extracted/assets/drizzle/sqlite/0013_compute.sql`
- `analysis/extracted/assets/drizzle/sqlite/0089_compute_pending_terminate.sql`
- `analysis/extracted/assets/drizzle/sqlite/0096_compute_providers_egress_policy.sql`

建议第一阶段只做一个窄而完整的 SSH job 闭环：输入 manifest 与 hash → 本地 staging → 提交到远端 → 持久化 remote job ID → 流式日志 → cancel 与断线 reconcile → 按声明的 output glob 回收 → 回收文件自动注册为 artifact → provenance 包含远程主机/provider、环境信息、job ID、输入版本、提交脚本、退出码与资源使用。先做完整单机 SSH，再考虑 Slurm、GPU provider 与 managed endpoint。

## 5. 产品启发（补充）

### 5.1 示例 Workspace：作为欢迎教程的补充（待验证假设）

reverse_cs 内置了多个完整科研案例（`analysis/extracted/assets/seed/manifest_crispr_screen.json`、`manifest_enzyme_engineering.json`、`manifest_extremophile.json`、`manifest_immunotherapy.json`），它们是可检查计划、执行、artifact、图表与报告的完整成果样板。假设：完整示例 Workspace 可能比纯文字欢迎教程更直观，或作为其补充。建议提供 2 个体量可控、尽量离线的 demo workspace（文献检索 → 数据表 → 图 → 报告；数据 QC → 分析 → provenance → review），用户可一键复制后修改重跑，并用可验证指标评估效果：首次成功产出 artifact 的时间、示例复制率、示例重跑完成率、onboarding 后首次任务成功率。

### 5.2 将轻量 Plan Card 推广到普通长任务

Research Loop 已有计划与确认 UI，但普通多步骤任务也可使用简化版：计划版本、批准或要求修改、当前步骤、修改未开始步骤、步骤与产物相互链接。不要强制每次聊天都进入 Research Loop，仅在任务确实多阶段、昂贵或有不可逆动作时启用。

## 6. 架构 / 数据模型启发

### 6.1 不把所有状态迁移到中心化 SQLite

reverse_cs 使用大量规范化 SQLite 表（`analysis/extracted/assets/drizzle/sqlite/` 下 90+ 迁移），查询能力强，但 workspace-first 文件模型是本项目的优势：可复制、可版本控制、无需数据库即可理解项目、符合 local-first。更合理的方式：

```text
普通文件 / JSON / JSONL = canonical source
.pi-science/index.sqlite = 可删除、可重建的查询索引
```

索引只服务 Artifact DAG、全文搜索与精确定位、跨会话查询、项目统计，**不能成为第二个业务状态权威**。

### 6.2 不复制巨型 daemon / 不打破三进程边界

reverse_cs 主 bundle 的美化提取约 43.4 万行，把大量业务集中在一个 daemon 中。本项目应保持：React 为唯一 UI、Node 为业务状态/安全/调度权威、Python 只做科学执行与解析、Pi Orbit 为 agent runtime。不要为模仿它而把科学业务状态放进 Python，或让 agent 直接管理数据库与凭据。

## 7. Agent / 科学工作流启发

- 阶段化 waypoint + 恢复逻辑（见 4.3）：可抽象为统一 waypoint schema，用于 systematic review、dossier、reproduction、dataset QC 等长流程，由 Node 管理状态、预算与恢复。
- "Trace, don't recompute"（见 4.4）：审查类角色只追踪证据链，不重跑计算，降低后台 agent 副作用并让审计更清晰。
- Publication Campaign 可作为产品差异化主线：manuscript → claim/figure arc → missing analyses → figure composition → traceability review → reproducible package。

## 8. 不建议照搬的部分

1. **中心化 SQLite 作为唯一状态权威**（见 6.1）——应保持文件为 canonical，SQLite 只做可重建索引。
2. **巨型单 daemon 架构**（见 6.2）——保持三进程边界。
3. **为工具数量绕过 Node 网络安全**——reverse_cs 内置约 247 个生物科学工具（统计口径：`assets/mcp-servers/bio-tools/lib` 下 18 个 Python 服务中的 213 个 `@…tool` 装饰器定义 + 5 份 `schemas.json` 声明的 34 个工具 = 247；工具数量本身不代表产品价值）。但本项目当前的官方 API 网关、敏感查询确认、SSRF 防护与 egress 审计更符合定位。后续新增 ClinicalTrials、ChEMBL、Open Targets 等连接器也应走 Node 控制面，而非让 Skill 直接 curl 或无治理地挂远程 MCP。
4. **routine（定时任务）**——提取版中 `isRoutine()` 返回 `false`、`tickRoutine()` 返回 `null`，属潜在设计而非已验证功能；只有出现"定期跟踪新文献、远程作业、数据更新"等真实需求时再做，且必须由 Node 调度，具有预算、锁、暂停与审计。

## 9. 路线图

### Quick wins

1. **会话书签与阅读位置**：用户书签、自动 bookmark 提案、精确 message/block anchor、恢复上次阅读位置、未读完成状态。
2. **两个完整 demo workspace**：展示从输入到 artifact、provenance、review 的完整闭环，可一键复制。
3. **Artifact 最小关系模型**：先增加明确版本的 `inputs`、`supersedes`、`intermediate`，Inspector 显示上游/下游关系；暂不做复杂图数据库。
4. **深化三个核心 Skill**：literature review、figure composer、traceability review；目标是 workflow contract、waypoint、验证与测试，而非增加 prompt 长度。

### Medium investments

1. **Artifact Library 与版本级 DAG**：项目级浏览、版本比较、dependency、supersession、annotation、正式/中间产物分类。
2. **可重建的 `.pi-science/index.sqlite`**：文件为 canonical，只增加高效查询层。
3. **Agent Capability Bundle**：profile 显式绑定 skills、connectors、connector tools、filesystem/network/host grants、compute provider；每次运行展示实际生效能力，由 Node/Pi runtime 强制执行。
4. **通用多阶段 Plan Card**：把计划版本、批准与步骤状态推广到 Research Loop 之外。
5. **完整 SSH 作业闭环**：staging、submit、logs、cancel、reconcile、harvest、artifact promotion 与 provenance。

### Strategic bets

1. **Publication Campaign**：manuscript → claim/figure arc → missing analyses → figure composition → traceability review → reproducible package，可能比增加单个科学工具更具产品差异化。
2. **通用可恢复科研工作流**：为 systematic review、dossier、reproduction、dataset QC 提供统一 waypoint schema。
3. **受控连接器与计算生态**：逐步引入版本、license、签名、网络目标、权限与 egress 声明；安全模型成熟后再考虑 marketplace。

## 10. 建议的决策优先级

需要区分两个维度：**战略重要性**（长期基础价值）与**交付顺序**（当前切入的可行性）。排序依据：战略杠杆（对"可审计科研项目系统"的奠基程度）、用户影响假设（是否解决高频痛点）、实现风险与依赖（是否涉及凭据/远端/运行时安全边界）。

**战略重要性**：

1. **Artifact Library + 版本级 DAG**：最基础的能力，是书签、Attention Queue、可审计性等其余体验的底层支撑；
2. **长会话书签、阅读状态与 Attention Queue**：提升长任务体验，依赖消息/block 的稳定身份；
3. **深工作流 Skills**：把 Research Loop 复用于可恢复科研 SOP；
4. **单机 SSH Job Lifecycle**：完整远程作业闭环，风险与依赖最高。

**交付顺序**（当前批次建议）：

1. **长会话书签、阅读状态与 Attention Queue**：相较完整 DAG 范围更易收敛，可作为第一批交付候选（仍需技术方案评估与 UAT 验证）；
2. **Artifact 最小关系模型**（第 9 节 Quick win 3）→ 逐步演进为 Artifact Library；
3. **深工作流 Skills**；
4. **单机 SSH Job Lifecycle**：涉及凭据、远端残留资源、取消一致性、输出回收与安全审计，风险最高，建议放最后。

即：不要优先追求更多 Skills、更多 MCP 或定时 Agent；先让现有能力产出的科研过程真正变得**可管理、可恢复、可追踪**。

## 11. 风险

- reverse_cs 为静态提取，部分模式（尤其 routine）可能未实际启用，借鉴前需按真实需求验证。
- Artifact DAG 与索引若设计过重，会侵蚀 workspace-first 的简洁性；应始终以文件为 canonical。
- 权限角色从 prompt 约束升级为运行时强制，涉及 Node/Pi runtime 改动，需保持与现有安全边界一致并补充测试。
- 远程计算闭环依赖远端环境差异，先以单机 SSH 收敛，避免过早支持多 provider；同时涉及凭据管理、远端残留资源与取消一致性，风险最高，建议最后实施。
- 许可边界：reverse_cs 顶层 `SKILL.md` 的 Apache-2.0 声明不代表覆盖整个 bundle/schema/prompt/UI；复用具体内容前需单独核查许可与 NOTICE，并检查第三方模型权重与服务许可。

## 12. 参考路径

### reverse_cs（`~/pi/reverse_cs/analysis/extracted/`）

- `claude-science`（原始 minified Bun bundle 的美化静态提取，约 433,812 行；构建为 public/external release，版本标签带 `-dev`，见 `assets/BUILD.json`；routines 相关：`isRoutine()` 约 190040 行、`tickRoutine()` 约 309877 行，提取版中分别固定返回 `false` / `null`）
- `assets/drizzle/sqlite/0000_yummy_ken_ellis.sql`、`0005_execution_log.sql`、`0013_compute.sql`、`0029_verification.sql`、`0038_transcript_annotations.sql`、`0055_frame_read_cursors.sql`、`0089_compute_pending_terminate.sql`、`0096_compute_providers_egress_policy.sql`
- `assets/web-dist/assets/ProvenancePane-DibqtOdI.js`、`assets/web-dist/assets/ProjectDashboard-yMcbMcpO.js`、`assets/web-dist/assets/FindingRow-NhgHKJiW.js`
- `assets/agents/operon/metadata.yaml`、`assets/agents/reviewer/metadata.yaml`、`assets/agents/bookmarker/metadata.yaml`、`assets/agents/onboarding/metadata.yaml`
- `assets/skills/indication-dossier/SKILL.md`、`assets/skills/indication-dossier/references/waypoint-schemas.md`、`assets/skills/figure-composer/SKILL.md`、`assets/skills/paper-narrative/SKILL.md`
- `assets/compute/operon_compute_provider/__init__.py`、`assets/compute/run.sh.tmpl`、`assets/compute/wrapper.sh.tmpl`
- `assets/seed/manifest_crispr_screen.json`、`manifest_enzyme_engineering.json`、`manifest_extremophile.json`、`manifest_immunotherapy.json`

### Pi-Science（本项目）

- `docs/architecture.zh-CN.md`、`docs/adr-research-loop-subagents.md`
- `apps/server/src/http/routes/artifact-routes.ts`、`apps/server/src/runtime/artifacts/turn-artifact-repository.ts`
- `apps/server/src/literature/providers.ts`、`apps/server/src/literature/literature-service.ts`
- `apps/server/src/security/outbound-security.ts`、`apps/server/src/security/egress-audit.ts`
- `apps/server/src/runtime/pi/pi-runtime-launch.ts`
- `apps/server/src/memory/ledger.ts`
- `apps/server/src/http/routes/catalog-routes.ts`
- `frontend/src/components/inspector/ArtifactInspector.tsx`、`frontend/src/components/inspector/ProvenancePanel.tsx`、`frontend/src/components/inspector/FilePreviewInspector.tsx`、`frontend/src/components/conversation/TurnArtifactStrip.tsx`、`frontend/src/components/conversation/ResearchLoopControls.tsx`、`frontend/src/components/settings/ComputeSettings.tsx`
- `skills/figure-composer/SKILL.md`（对比 reverse_cs 的 figure-composer 工作流深度）

## 13. 结论

> 不要优先追求更多 Skills、更多 MCP 或定时 Agent；先让现有能力产出的科研过程真正变得可管理、可恢复、可追踪。

这样最能在不破坏 local-first 与 React/Node/Python 安全边界的前提下，把 Pi-Science 从"能力齐全的科研聊天工作台"推进为"可审计的科研项目系统"。

---

## 14. 本 PR 已实现的 initial slice（2026-08）

以下内容对应本仓库已合并/已实现的两个里程碑（详见 `docs/adr-conversation-navigation-artifact-lineage.md`），是上文建议的**第一批落地范围**；其余建议仍为后续规划，未在本 PR 内实现。

### 14.1 会话导航（conversation navigation）

- 持久书签：`user`/`agent_proposal`/`legacy_auto` 三种 origin；proposal 必须显式接受，不再自动 accepted；
- 旧 `.pi-science/bookmarks.jsonl` 只读折叠迁移，不删除、不重写原文件；
- 阅读位置：`anchor_message_id` + `at_bottom` + `seen_snapshot_version`，`before` locator 每次动态重解析；
- Attention Queue（仅 sidebar 状态）：`needs_you`（运行时 pending interaction）、`running`（busy runtime）、`unread`（有 read state 且 snapshot 变化、最新可见消息为 assistant）；
- 旧 session 无 read state 一律按 `idle`，升级后不会全部标为 unread；
- 新增 `GET/POST /api/bookmarks`、`PATCH/DELETE /api/bookmarks/:id`、`POST /api/bookmarks/propose`、`GET/PUT /api/sessions/:id/read-state`、`GET /api/attention`，全部 Node native；
- canonical 状态：`.pi-science/conversation-navigation.json`（schema v1，fail-closed），不存绝对路径、不存 opaque cursor。

### 14.2 Artifact 版本关系（versioned lineage）

- artifact manifest v2（additive）：`schema_version: 2`、exact `ArtifactVersionRef` inputs、`supersedes`、`classification`（`intermediate`/`deliverable`/`unspecified`）；
- 兼容规则：v1 行不原地迁移，读取时按 `unspecified` 解释；同 `artifact_id + version` 重复行按最后一条获胜（verify 追加行）；
- 显式 publish 默认 `deliverable`；Node 自动发现的 write/edit 产物默认 `intermediate`；
- `GET /api/artifacts/:id/lineage` 返回 upstream（consumes/supersedes）、downstream（consumed_by/superseded_by）与 unresolved legacy string inputs；
- 校验：missing/duplicate/self-version refs 与跨 workspace 引用均 422；每版本最多 100 个 versioned inputs；
- Inspector 在 Provenance 历史之上嵌入 Lineage 面板，可点击打开关联文件；无 manifest 或接口不可用时渲染为空（不挤占普通文件历史）。

### 14.3 明确未实现（非目标）

- 后台自动 Bookmarker 定时运行、Plan ready / unresolved review finding 的 Dashboard 聚合、完整 Artifact Library 页面、SQLite/图数据库索引；
- 远程 SSH Job Lifecycle、routine 定时任务、MCP 扩展、Python 业务状态；
- 深工作流 Skills（literature-review / figure-composer / traceability-review 重构）。

回滚说明：新状态全部为 workspace-local 附加文件（`conversation-navigation.json`、artifacts.jsonl 的 additive 字段），回滚代码不会破坏旧会话、旧 artifact 与旧 publish 流程。
