# Pi-Science 定时任务（Scheduled Tasks）方案

> 本文档只设计 **Node 控制平面、前端和 Pi agent** 的协作方式。`backend/`（Python 科学运行时）不保存定时任务状态，不承担 cron 调度职责，仅按现有边界继续执行 kernel/notebook 与文件解析。
> 本文依据 `.pi-subagents/chain-runs/9487ac9a/plan.md` 编写；第 2 节场景素材来自 `.pi-subagents/research-brief.md`（仅引用，不改动该文件）；第 3.1 节同类产品设计素材来自 `.pi-subagents/scheduled-ux-brief.md`（仅引用，不改动该文件）。

## 1. 背景与目标

### 1.1 背景

科研工作中有大量低频、可轮询的自动化需求：新论文检索、引文跟踪、数据集版本监控、依赖更新提醒等。这些需求现在只能靠用户手动刷网页、查邮件或维护外部 cron。Pi-Science 已有 headless Pi agent、`literature-review` skill 和文献网关（`LiteratureService`），具备把它们组合成"本地定时任务"的基础。

### 1.2 目标

- **首个目标是"定时文献收集"（literature_digest）**，不是一次性交付通用工作流平台。先做透一个场景（cron + headless agent + `literature-review` + `web_search`），再逐步扩展任务类型。
- 左侧任务栏**按 workspace 展示任务**：每个 workspace 的任务独立列出、独立执行。
- 控制平面（`apps/server/`）是任务定义、触发状态、审批状态和执行历史的**唯一状态权威**。
- 定时任务能力全部由控制平面统一调度、审批和安全收口，不依赖外部 cron 服务，不依赖浏览器常驻。
- `backend/` 不保存任何定时任务状态（见本文开头约束）。

### 1.3 边界声明

- 本文设计的功能全部位于控制平面（调度、状态、审批、历史）和前端（任务栏 UI）。
- Pi agent 只作为"执行器"被调用：headless 启动、给定任务 prompt、写回报告和 manifest。
- 定时触发依赖控制平面进程存活（见第 6 节风险 R1）。

## 2. 科研定时任务场景清单

落地难度三档定义：

- **现在就能做**：只需补齐通用调度模块（本文第 3、4 节的 MVP 框架），不需要新的外部基础设施。
- **需要少量新能力**：需要新 connector、命令适配（通过 `JobCoordinator` 执行 shell 命令）或通知通道。
- **需要较大投入**：需要 DAG、跨系统状态恢复、资源编排或持续自治。

### 2.1 现在就能做

| 做什么 | 数据源/工具 | 频率 | 产出物 |
| --- | --- | --- | --- |
| arXiv 新论文日报 | arXiv API（query 接口）+ 分类 RSS | 每日一次 | Markdown 日报（标题/摘要/链接/去重键）+ 来源 manifest |
| PubMed 新文献日报 | PubMed E-utilities（esearch/efetch） | 每日一次 | Markdown 日报 + 来源 manifest |
| 期刊 TOC 周报 | 期刊 TOC 邮件（Elsevier/Springer）或期刊 RSS | 每周一次 | TOC 摘要周报 |
| OpenAlex 引文和 arXiv 版本更新周报 | OpenAlex API（被引查询）、arXiv API（versions） | 每周一次 | 引文/版本变化周报 |
| Zenodo 数据集版本监控 | Zenodo REST API（records/versions 端点） | 每日一次 | 版本变更通知 + manifest |
| Kaggle 数据集版本监控 | Kaggle API（datasets list） | 每日一次 | 版本变更通知 |
| HuggingFace 数据集版本监控 | HuggingFace Hub API（时间戳比对） | 每日一次 | 版本变更通知 |
| GitHub issue/PR 周报 | GitHub API（按 repo/时间过滤） | 每周一次 | issue/PR 周报 |
| 依赖更新周报 | Dependabot/Renovate 已开 PR + GitHub API | 每周一次 | 待处理依赖更新清单 |

### 2.2 需要少量新能力

| 做什么 | 数据源/工具 | 频率 | 产出物 |
| --- | --- | --- | --- |
| Papermill/Ploomber notebook 定时重跑 | Papermill 参数化执行 + Ploomber 增量缓存，经 `JobCoordinator` 执行 | 每日一次（重跑类）或每周一次 | 参数化运行结果 + 运行日志 |
| SLURM `squeue`/`sacct` 作业状态监控 | SLURM 命令经 `JobCoordinator` 执行并解析 | 每 5–10 分钟 | 状态变更、完成/失败通知 |
| Great Expectations 数据质量检查 | Great Expectations 套件（命令行或 Python） | 每日一次 | 数据质量检查报告 |
| iCal、aideadlines.org 会议截止提醒 | iCal 订阅解析（aideadlines.org 等） | 每日一次（按提前 1 周 + 3 天 + 当天触发） | 截止日期提醒清单 |
| Grants.gov 基金截止提醒 | Grants.gov 订阅/RSS 抓取 | 每日一次 | 基金截止提醒清单 |

### 2.3 需要较大投入

| 做什么 | 数据源/工具 | 频率 | 产出物 |
| --- | --- | --- | --- |
| 跨数据源多阶段科研情报工作流 | 文献 + 数据集 + 代码多源聚合，阶段化（检索 → 筛选 → 综述） | 每日一次或每周一次 | 综合情报报告 |
| `ResearchLoopCoordinator` 定时恢复和长期自治 | research-loop 状态持久化 + 定时续跑 | 周期性（按研究循环定义） | 研究循环续跑记录 |
| GPU/SLURM 资源申请、失败分析和自动重试 | SLURM `sbatch`/`sacct` + 日志分析 | 事件驱动，分钟级检查 | 作业提交记录、失败分析报告、重试记录 |
| 带依赖、条件分支和人工检查点的 DAG 编排 | DAG 调度器（自研或引入 Airflow/Ploomber） | 按 DAG 定义 | 端到端工作流产物 |

### 2.4 外部工具限制说明

调研简报（`.pi-subagents/research-brief.md`）指出 GitHub Actions cron 存在以下限制：

- 调度有分钟级延迟；
- 免费计划 60 天无仓库活动会暂停调度；
- 单任务 6 小时上限（自托管除外）。

**这些限制是外部工具（GitHub Actions）的限制，不是 Pi-Science 本地调度器的既成限制。** 本地调度器由控制平面持有状态（见 3.6），不受上述规则约束；但 Pi-Science 未运行时的触发缺口依然存在（见第 6 节 R1）。调研简报中的工具能力对比（如 Google Scholar Alerts 无公开 API、arXiv API 免费实时但无引文数据）作为场景选择依据写入第 2 节，不代表 Pi-Science 已验证的运行保证。

## 3. 功能设计

### 3.1 同类产品设计与借鉴

调研范围（素材来自 `.pi-subagents/scheduled-ux-brief.md`）：ChatGPT Scheduled Tasks、Claude Cowork、n8n、GitHub Actions、Zapier/Make、crontab.guru、Airflow、Papermill/SLURM。共性模式：

- 频率双层选择：预设（每天/每周/每工作日）+ 自定义 cron，且 cron 有可视化预览（crontab.guru 式实时解释是标配思路）；
- 统一任务列表页：展示下次运行时间与状态；
- 执行历史时间线 + 状态徽标 + 失败可重试（GitHub Actions / n8n 同款）；
- 创建时引导通知/审批授权（ChatGPT 首次创建即引导授权）；
- 约束显式化：活跃任务配额、频率上限明示给用户（ChatGPT 按套餐 3–15 个）。

**我们借鉴**：cron 三件套（预设 + 自定义 + 实时解释 + 下次 5 次触发预览）；历史时间线 + 重试；暂停/恢复；时区显式展示；自然语言创建入二期（表单二次确认，借鉴 Claude Cowork 模式）。

**我们避免**：完全隐藏 cron 语法（Zapier 模式，高级用户无法精确控制）；纯 YAML 无预览（GitHub 对非开发者门槛高）；任务状态散落在聊天里没有专页；无配额导致资源失控。

**本地化原则**：文件即状态（借鉴 GitHub Actions workflow 文件入仓库，但任务定义放元数据目录防误改）；桌面本地优先（触发依赖控制平面进程存活，UI 要明示，见第 6 节 R1）。

### 3.2 呈现形式

- 路由：`/workspace/:cwd/scheduled-tasks`（与现有 `/workspace/:cwd/files`、`/workspace/:cwd/research` 等并列，见 `frontend/src/app/router.tsx`）。
- 入口：`frontend/src/app/layout/ProjectsLayout.tsx` 的**展开导航和折叠导航都增加入口**（参照现有 `SidebarNavItem` / `CollapsedNavItem` 用法）。
- 页面包含：
  - 任务列表（按 workspace 过滤）；
  - 每行：启用状态、下次运行时间、最近一次运行状态；
  - 操作：创建、手动运行、暂停、编辑、删除；
  - 历史详情（点击单次运行进入，见 3.8）。
- **任务列表项**（卡片或表格行）字段：名称、类型徽标（MVP 只有 `literature_digest`）、启用开关、下次运行时间（相对时间显示，hover 显示绝对时间与时区）、上次运行状态徽标（成功 ✓ / 失败 ✗ / 跳过 / 待审批 `needs_attention`，用颜色区分）、「立即运行」按钮。
- **任务详情视图**（点击任务进入）：配置摘要（cron 人类可读解释 + 原始表达式 + 时区、查询内容、输出路径）；运行历史时间线（每次运行一行：触发方式 cron/manual/reconcile、状态徽标、耗时、产出文件链接、失败原因、token 与费用）；操作按钮（编辑/暂停/删除/立即运行）。
- **结果呈现**：产出 Markdown 报告通过现有 inspector 面板预览（点击历史里的文件链接打开）。
- **空状态**：无任务时显示引导文案和「创建第一个定时任务」按钮。
- **配额显式化**：活跃任务上限（如 20 个），超限时提示（借鉴 ChatGPT 的配额显式做法）。

### 3.3 用户制定与修改流程

**制定**（任务栏「+」→ 单页分组表单，MVP 不做多步向导），表单分四区：

- ① **做什么**：任务名称；任务类型（MVP 只有 `literature_digest`）；执行内容（查询词、数据源、skill 参数等，按任务类型结构化）。
- ② **何时**：预设（每小时/每天/每工作日/每周）+ 自定义 5-field Unix `cron` 表达式（分 时 日 月 周）；实时显示人类可读解释和**后续 5 次触发时间**；IANA timezone（默认取服务器时区，可在列表中改）。
- ③ **输出**：workspace-relative 输出位置（默认 `reports/literature/<task_id>/`，见 3.4），显示最终路径。
- ④ **确认**：敏感词预检结果、审批说明（见 3.7）。

表单实时校验 cron 表达式（用 `cron-parser`，见 3.6）。创建成功后提示可「立即运行一次」验证。

**修改**：

- **编辑**：表单预填 → 修改 → 保存。只改名称/时间**不使审批失效**；改查询/provider/工具等执行内容 → `revision`+1、任务级审批自动失效需重新批准（见 3.7）。
- **暂停/启用**：开关控制 `enabled`；暂停不触发、不计算 `next_run_at`。
- **删除**：确认对话框；删除后停止触发，历史保留并标注任务已删除。
- **手动运行**：立即触发，`trigger=manual`，与 cron 互不影响。

### 3.4 任务数据模型与文件位置

#### 任务定义（`tasks/<task_id>.json`）

建议字段：

| 字段 | 说明 |
| --- | --- |
| `task_id` | 唯一 ID（UUID） |
| `schema_version` | 数据模型版本，用于迁移 |
| `revision` | 任务内容修订号；审批绑定 revision，编辑后递增 |
| `name` | 任务名称 |
| `type` | 任务类型（MVP：`literature_digest`） |
| `enabled` | 是否启用（暂停 = `false`） |
| `schedule.cron` | 5-field cron 表达式 |
| `schedule.timezone` | IANA timezone |
| `executor.kind` | 执行器类型（MVP：`headless_agent`，见 3.5） |
| `executor.config` | 执行器配置（prompt、skill、provider 列表、数据源等） |
| `output.relative_path` | workspace-relative 输出目录 |
| `approval_policy` | 审批策略（`none` / `require_approval`，含绑定 revision） |
| `retry_policy` | 重试策略（次数、间隔、不重试的失败类别） |
| `next_run_at` | 下次触发时间（持久化，供重启恢复） |
| `last_run_at` | 最近一次触发时间 |
| `created_at` / `updated_at` | 创建/更新时间 |

#### 单次运行（`runs/<run_id>.json`）

建议字段：

| 字段 | 说明 |
| --- | --- |
| `run_id` | 运行 ID（UUID） |
| `task_id` | 所属任务 |
| `scheduled_for` | 计划触发时间 |
| `trigger` | 触发方式：`cron` / `manual` / `reconcile`（重启补跑） |
| `idempotency_key` | `task_id + scheduled_for` 组成的幂等键 |
| `status` | `pending` / `running` / `succeeded` / `failed` / `needs_attention` / `skipped` |
| `attempt` | 当前重试次数（0 起） |
| `execution_id` | 底层执行记录 ID（与统一执行记录对齐时使用） |
| `started_at` / `ended_at` | 起止时间 |
| `output_paths` | 产出文件列表（报告、manifest 等） |
| `error` | 失败原因（含不可重试类别标记） |
| `usage` | token 数、费用（来自 Pi 进程事件，参照 `subagent-runner.ts` 的 usage 累计） |

#### 持久化位置

均位于 workspace 的 `.pi-science/` 元数据目录（`metadataRoot(workspace)`，见 `apps/server/src/storage/persistence.ts`）：

- `.pi-science/scheduled-tasks/tasks/<task_id>.json` — 任务定义；
- `.pi-science/scheduled-tasks/runs/<run_id>.json` — 单次运行记录；
- `.pi-science/scheduled-tasks/logs/<run_id>.log` — 运行日志尾部（供历史页展示）；
- 用户可见结果默认写入 workspace 内 `reports/literature/<task_id>/YYYY-MM-DD.md`（+ 同目录 manifest JSON）。

#### 文件位置决策

- **任务定义与运行历史是机器状态**（触发时间、revision、审批、lease），放 workspace 元数据目录 `.pi-science/scheduled-tasks/`（与 `metadataRoot` 一致）：不进用户 git、防误改，控制平面是唯一写入者；整个目录可整体备份/迁移。
- **为什么不用数据库**：本地优先、文件即状态，与现有持久化设施（`withFileWriteLock` + JSON 原子写）一致。
- **产出文件为什么用户可见**：报告是用户资产，默认 `reports/literature/<task_id>/YYYY-MM-DD.md`，可配置 `output.relative_path`；可在 inspector 预览、可被用户引用。实现时核实 `.gitignore` 是否已忽略 `.pi-science` 元数据目录。
- **文件冲突策略**：同一天多次运行默认覆盖当天文件（日报语义），manifest 记录全部来源；若检测到用户手工修改过（内容 hash 对比），则写新文件 `YYYY-MM-DD-HHmm.md` 并在该次运行历史中标注；运行历史与日志默认保留 90 天（二期做配置项）。

### 3.5 执行引擎选型

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| headless Pi agent | 灵活，直接使用 `literature-review` skill、`web_search`、`fetch_content`，能综合写作 | 成本和不确定性较高（LLM 费用、输出漂移） | **MVP 选用** |
| 直接调用 `LiteratureService`/API | 结构稳定、便宜、安全边界清楚（敏感词门禁 + egress audit 已内置） | 综合写作能力较弱，扩展场景受限 | 二期加入为直接文献网关 executor（见第 5 节） |
| `ResearchLoopCoordinator` | 适合候选—执行—评估循环 | 不适合普通日报轮询（状态重、开销大） | 不用于 MVP 的定时任务执行；远期研究循环续跑另行设计 |

**MVP 选择：独立的 headless Pi agent runner。**

- 不通过 `NodeSessionService` 创建用户可见聊天会话——定时执行与聊天会话完全隔离。
- runner 复用 `PiManager`、`buildPiProcessOptions()`、`loadDefaultPiConfig()` 和 `WorkspaceEnvironmentService`（参照 `apps/server/src/research-loop/subagent-runner.ts` 的既有模式）。
- 每次运行使用独立 session 目录：`.pi-science/scheduled-task-sessions/<run_id>/`（`--session-dir` 指向该目录）。
- 确定性脚本和 notebook 任务后续交给 `JobCoordinator`（`apps/server/src/runtime/jobs/job-coordinator.ts`）。
- **`JobCoordinator` 是执行器，不是 cron 调度器**：它负责命令执行、超时和 orphan 恢复，没有定时触发能力；cron 触发由本文的 `ScheduledTaskCoordinator` 负责。

### 3.6 调度器设计

- 调度逻辑放在 **Node 控制平面**（新组件 `ScheduledTaskCoordinator`，见第 4 节）。
- 使用 `cron-parser` 做表达式校验、timezone 计算和 `next_run_at` 计算（该依赖后续引入，本次文档任务不修改依赖）。
- **不使用 OS cron 作为状态权威**：任务定义、`next_run_at`、运行记录都持久化在 workspace 元数据目录，控制平面是唯一权威。
- 服务启动时扫描已知 workspace，加载任务并执行 **reconcile**（对漏过的时间点只合并成一次运行，不回放大量历史时间点）。
- 服务关闭时停止所有 timer 和正在管理的 runner 进程。
- 防重复执行：
  - 所有写操作经 `withFileWriteLock()`（`apps/server/src/storage/persistence.ts`）串行化；
  - 运行前校验任务 `revision`（任务被编辑则不跑旧版本）；
  - 运行时持有运行 lease（记录在 run 记录中，过期可回收）；
  - 幂等键 `task_id + scheduled_for`，同一时间点只产生一次运行。
- 同一任务默认**禁止重叠运行**：上一运行未结束时，到点的触发标记为 `skipped`。
- 服务重启恢复：以持久化的 `next_run_at` 为基准重算调度，不依赖内存 timer 的累计（内存 timer 不持久化会导致漏跑/重复，见第 6 节 R2）。

### 3.7 安全设计

- **输出路径隔离**：`output.relative_path` 必须经 `resolveWorkspaceFile()` / `validateWorkspaceCwd()` 检查（`apps/server/src/security/workspace-security.ts`），不能逃出 workspace。
- **secret 管理**：secret 只从现有设置或环境读取（如 provider API key），绝不写进任务 JSON、prompt 或日志。
- **任务级审批**：
  - recurring approval 绑定任务 `revision` 和执行内容 hash；
  - 编辑查询、provider 或工具后自动失效，需要重新审批；
  - 审批决策记录进 egress audit（复用 `recordEgress`，`apps/server/src/security/egress-audit.ts`）。
- **headless 不弹交互审批**：headless 模式不能弹出交互式审批 UI；需要审批而未获批时，运行置为 `needs_attention`，不发起外部请求。
- **不可信输入隔离**：fetched web content 按不可信输入处理（可能含 prompt injection），只作为报告素材，不能允许其改变任务范围或执行任意命令。
- **出网收敛**：为任务配置 provider/domain allowlist、运行超时、并发上限和费用预算。
- **高危缺口**：headless Pi agent 的 web 工具直接发出的 HTTP 请求**不会自动经过**文献网关的 egress audit 和敏感词门禁（`literature-service.ts` 的 `detectSensitiveTerms` 门禁只覆盖经网关的请求）。控制平面必须补齐：在触发运行前对任务查询做敏感词检查（复用 `detectSensitiveTerms`，`apps/server/src/security/sensitive-terms.ts`），并对 headless 运行做 egress 记录（见第 6 节 R4）。

### 3.8 结果、日志和重试

- **结果**：Markdown 报告写回 workspace（默认 `reports/literature/<task_id>/YYYY-MM-DD.md`）。
- **manifest**：JSON manifest 保存来源、查询、去重键（复用文献去重逻辑，`deduplicate()`）、执行时间和输出文件列表。
- **历史页**：展示日志尾部、失败原因、token 用量和费用（来自 run 记录的 `error`、`usage`）。
- **重试策略**（MVP）：
  - 网络错误、HTTP 429、5xx、runtime 启动失败：最多重试 2 次；
  - **不重试**：敏感词阻断、无效 cron、路径越界、审批缺失。
- **外部服务不保证可用**：搜索服务受 API quota、rate limit、网络和 provider 可用性影响，失败由重试策略兜底。
- **内容可达性不保证**：动态网页、登录墙、CAPTCHA 和仅浏览器可访问的数据源不能保证成功。
- **不自动执行 `git commit`**：结果只是写文件，提交由用户决定。

## 4. 代码落地映射

约定：`[现有]` = 当前仓库已存在（本文编写时已用 `test -e` 核实）；`[建议新增]` = 当前不存在，为本方案建议创建。

### 4.1 建议新增的服务端文件

- `apps/server/src/scheduled-tasks/repository.ts` — 任务与运行记录的读写（`withFileWriteLock` + JSON 原子写）。
- `apps/server/src/scheduled-tasks/coordinator.ts` — `ScheduledTaskCoordinator`：cron 解析、timer 调度、reconcile、幂等与 lease、关闭清理。
- `apps/server/src/scheduled-tasks/headless-agent-runner.ts` — headless Pi agent 执行器（复用 `PiManager` / `buildPiProcessOptions()` / `loadDefaultPiConfig()` / `WorkspaceEnvironmentService`）。
- `apps/server/src/scheduled-tasks/executors.ts` — 执行器注册与分派（`headless_agent`；二期加 `literature_gateway`、`job_command`）。
- `apps/server/src/http/routes/scheduled-task-routes.ts` — HTTP 路由。
- 对应的 `*.test.ts`（repository、coordinator、headless-agent-runner、routes）。

### 4.2 需要修改的服务端文件

- `[现有] packages/contracts/src/index.ts` — 增加 task、run 和 API 的 DTO schema；如接入统一执行记录，增加 `scheduled_task` execution kind。
- `[现有] apps/server/src/app/server-modules.ts` — 创建并暴露 `ScheduledTaskCoordinator`（参照现有 `jobs` / `research` 的组装方式）。
- `[现有] apps/server/src/app/app.ts` — 注册路由、启动 reconcile、关闭 coordinator。
- `[现有] apps/server/src/http/runtime-boundaries.ts` — 注册 `/api/scheduled-tasks`。**不注册的未知 `/api/` 路由会在 `onRequest` 阶段返回 404**。

### 4.3 建议 API（全部由 Node 控制平面负责）

- `GET /api/scheduled-tasks?cwd=...` — 任务列表；
- `POST /api/scheduled-tasks?cwd=...` — 创建任务；
- `GET /api/scheduled-tasks/:task_id?cwd=...` — 任务详情；
- `PATCH /api/scheduled-tasks/:task_id?cwd=...` — 更新任务（编辑后 revision 递增、审批失效）；
- `DELETE /api/scheduled-tasks/:task_id?cwd=...` — 删除任务；
- `POST /api/scheduled-tasks/:task_id/run?cwd=...` — 手动执行；
- `GET /api/scheduled-tasks/:task_id/runs?cwd=...` — 运行历史；
- `GET /api/scheduled-tasks/:task_id/runs/:run_id?cwd=...` — 单次运行详情（含日志尾部、错误、usage）。

### 4.4 建议新增的前端文件

- `frontend/src/app/routes/ScheduledTasksPage.tsx` — 任务列表 + 历史详情页。
- `frontend/src/lib/scheduled-tasks.ts` — API 客户端与类型。
- `frontend/src/app/routes/ScheduledTasksPage.test.tsx` — 页面测试。

### 4.5 需要修改的前端文件

- `[现有] frontend/src/app/router.tsx` — 增加 `/workspace/:cwd/scheduled-tasks` 路由。
- `[现有] frontend/src/app/layout/ProjectsLayout.tsx` — 展开和折叠导航都增加入口。
- `[现有] frontend/src/app/layout/ProjectsLayout.test.tsx` — 补充导航断言。
- `[现有] frontend/src/i18n/locales/en.json` — 新增文案。
- `[现有] frontend/src/i18n/locales/zh-Hans.json` — 新增文案。

### 4.6 复用点清单

| 模块 | 路径 | 复用内容 |
| --- | --- | --- |
| 持久化 | `[现有] apps/server/src/storage/persistence.ts` | `withFileWriteLock()`、`writeJsonAtomic()`、`metadataRoot()` |
| 路径安全 | `[现有] apps/server/src/security/workspace-security.ts` | `validateWorkspaceCwd()`、`resolveWorkspaceFile()` |
| 出网审计 | `[现有] apps/server/src/security/egress-audit.ts` | `recordEgress()`（审批记录 + headless 出网记录） |
| 敏感词门禁 | `[现有] apps/server/src/security/sensitive-terms.ts` | `detectSensitiveTerms()`（任务查询预检） |
| 文献网关 | `[现有] apps/server/src/literature/literature-service.ts` | `LiteratureService`（二期 executor）、`deduplicate()`（去重键） |
| 命令执行 | `[现有] apps/server/src/runtime/jobs/job-coordinator.ts` | 二期确定性脚本/notebook 执行（作为执行器，不承担调度） |
| 研究循环 | `[现有] apps/server/src/research-loop/coordinator.ts` | `ResearchLoopCoordinator`（远期续跑，不用于 MVP 轮询） |
| headless runner 范式 | `[现有] apps/server/src/research-loop/subagent-runner.ts` | `PiManager` + `buildPiProcessOptions()` + `loadDefaultPiConfig()` + `WorkspaceEnvironmentService` 的组合范式 |
| 前端页面范式 | `[现有] frontend/src/components/layout/WorkspacePage.tsx` | 页面骨架复用 |

## 5. 分阶段实施

### 5.1 MVP（第一阶段）

- 任务类型：只支持 `literature_digest`。
- 功能：cron + timezone + 启用/停用 + 手动执行 + 历史记录。
- 执行器：headless Pi agent（`PiManager` + `buildPiProcessOptions()` + `loadDefaultPiConfig()` + `WorkspaceEnvironmentService`），独立 session 目录，不建用户可见会话。
- 能力要求：`literature-review` skill + `web_search` + `fetch_content`。
- 产出：Markdown 报告 + 来源 manifest（含查询、去重键、来源、输出文件）。
- 安全：敏感词检查（任务级预检）、任务级审批（绑定 revision + 内容 hash）、provider allowlist、去重、失败重试（网络/429/5xx/启动失败最多 2 次）。
- 不包含：DAG、复杂通知、完整集群编排。

### 5.2 二期（第二阶段）

- 加入直接文献网关 executor（调 `LiteratureService`，天然继承敏感词门禁与 egress audit）。
- 加入更多任务类型：数据集监控（Zenodo/Kaggle/HuggingFace）、notebook 重跑（Papermill，经 `JobCoordinator` 执行）、数据质量检查（Great Expectations）。
- 加入通知：邮件、Webhook、Slack。
- 加入策略配置：运行费用上限、并发上限、运行记录和日志保留周期。

### 5.3 远期（第三阶段）

- DAG 编排（任务依赖、条件分支）。
- 条件触发和任务依赖（事件驱动触发）。
- `ResearchLoopCoordinator` 定时续跑和长期自治。
- 跨服务恢复、长期预算控制、人工检查点。

## 6. 风险与未决问题

### 6.1 风险清单

| 编号 | 级别 | 风险 | 说明与对策 |
| --- | --- | --- | --- |
| R1 | High | Pi-Science 未运行时任务不会触发 | 本地调度依赖控制平面进程。未决：是否需要桌面自启动（launchd/systemd/user autostart）或系统 service；何时把该决定做成设置项 |
| R2 | High | 内存 timer 不持久化导致重启漏跑/重复 | `next_run_at`、lease、幂等键必须持久化；启动 reconcile 只合并漏过的时间点为一次运行（见 3.6）。**若只依赖 Node 内存 timer，重启或多实例必然出问题** |
| R3 | Medium | 新增 API 未注册 boundary | 新 API 必须在 `apps/server/src/http/runtime-boundaries.ts` 注册，否则 `app.ts` 在 `onRequest` 阶段返回 404 |
| R4 | High | headless Pi agent 的 web 工具发出的 HTTP 请求不经过文献网关的 egress audit / 敏感词门禁 | `egress-audit.ts` 的审计和 `literature-service.ts` 的 `detectSensitiveTerms` 门禁只自动覆盖经网关的请求。**控制平面必须补齐**：任务查询预检敏感词 + headless 出网 egress 记录 + provider/domain allowlist |
| R5 | Medium | `JobCoordinator` 是执行器，不是 cron 调度器 | 不能把它描述成现成调度器；定时触发一律由 `ScheduledTaskCoordinator` 负责 |
| R6 | Medium | `--approve` ≠ 任务级网络审批 | `--approve` 只是 Pi runtime 启动参数；长期外部网络访问仍需 revision-bound 任务审批（见 3.7） |
| R7 | Medium | 文档输入材料缺失 | 蓝图提及的 `context.md` 在指定路径未找到；本文以蓝图正文和 `.pi-subagents/research-brief.md` 为完整输入 |
| R8 | Low | 调研简报是外部能力对比 | 第 2 节场景按"选择依据"使用，不构成 Pi-Science 已验证的运行保证 |

### 6.2 未决问题

- **timezone / DST / 漏触发策略**：DST 切换时按 wall-clock 还是 absolute time 触发；停机跨多个触发点时的合并策略细节。
- **recurring approval 的有效期与撤销方式**：除编辑失效外，是否需要定期复审（如 30/90 天）、全局撤销入口。
- **API quota、费用上限与 provider fallback**：quota 耗尽时的降级顺序、跨 provider 的授权方式、费用上限的记账口径（token 单价来自 Pi 事件 usage，见 3.4）。
- **文献去重键和历史 checkpoint 的迁移**：`deduplicate()` 的键格式演进时，历史 checkpoint 如何迁移（`schema_version` 字段预留）。
- **外部内容 prompt injection**：fetched web content 是可信度未知的输入，需要明确报告渲染时的转义边界和"内容不改任务范围"的执行约束（见 3.7）。
- **headless Pi agent 的 egress audit 接入缺口**：是记录"发起请求的查询内容"还是"实际出网 URL"，需要实现时定口径（见 R4）。
- **运行记录和日志保留周期**：`runs/` 和 `logs/` 的默认保留时长、清理策略（二期做配置项）。
- **多控制平面实例同时打开同一 workspace 的 ownership**：两个 `apps/server` 实例指向同一 workspace 时的任务锁与 lease 归属（`withFileWriteLock` 只能串行化单操作，不能解决实例间调度竞争）。
- **结果文件冲突与用户手工修改**：报告已存在时是覆盖、跳过还是生成新文件；用户手工改过报告后再次触发如何处理。

---

**验收执行记录**（编写本文时执行）：

```bash
test -f docs/scheduled-tasks-plan.md
rg '^## ' docs/scheduled-tasks-plan.md
```

现有路径核实（`test -e`）：`scripts/fetch-pi.sh`、`apps/server/src/runtime/pi/pi-runtime-launch.ts`、`apps/server/src/runtime/node/node-session-service.ts`、`apps/server/src/research-loop/subagent-runner.ts`、`apps/server/src/runtime/pi/pi-manager.ts`、`apps/server/src/runtime/workspace/workspace-environment.ts`、`apps/server/src/storage/persistence.ts`、`apps/server/src/security/workspace-security.ts`、`apps/server/src/security/egress-audit.ts`、`apps/server/src/security/sensitive-terms.ts`、`apps/server/src/literature/literature-service.ts`、`apps/server/src/runtime/jobs/job-coordinator.ts`、`apps/server/src/research-loop/coordinator.ts`、`packages/contracts/src/index.ts`、`apps/server/src/app/server-modules.ts`、`apps/server/src/app/app.ts`、`apps/server/src/http/runtime-boundaries.ts`、`frontend/src/app/router.tsx`、`frontend/src/app/layout/ProjectsLayout.tsx`、`frontend/src/app/layout/ProjectsLayout.test.tsx`、`frontend/src/components/layout/WorkspacePage.tsx`、`frontend/src/i18n/locales/en.json`、`frontend/src/i18n/locales/zh-Hans.json`、`skills/literature-review/SKILL.md` 均存在。本文只新增 `docs/scheduled-tasks-plan.md`，不修改其他文件；`git status` 仅显示该未跟踪文件，无暂存变更。
