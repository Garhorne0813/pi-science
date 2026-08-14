# Pi-Science「Skills 系统与 Research Loop」勘察报告（为方案 4.3 做实现准备）

> 勘察范围：只读。路径为工作区根 `/Users/cyq/deepseek`（git worktree，分支 `feat/reverse-cs-inspiration`）。所有行号基于当前工作区实际文件。

---

## 1. skills/ 目录全景（14 个内置 skill）

每个 skill 的结构远简单于设计文档描述。**没有**任何 skill 带 `references/` 或 `assets/` 子目录；`reference/`（单数）是作者指南里写的可选约定，但**零个 skill 使用**。实际只有 `SKILL.md` + 可选 helper 脚本 + 可选 `tests/`。Skill 树完整清单：

| Skill | 结构 | 深度评估 | 测试 |
|---|---|---|---|
| **literature-review** | `SKILL.md`(128行) + `tests/{skill-content.test.ts, fixtures.json, workflow-fixtures.json}` | ✅ 最深。有检索策略、网关/直连/回退、强制 citation 输出契约、review 产物清单 | 7 tests |
| **figure-composer** | `SKILL.md`(22行) + `tests/fixtures.json` | ⚠️ 极浅。仅 22 行正文，无 schema、无 waypoint | **无 .test.ts**（fixtures 无人消费) |
| **traceability-review** | `SKILL.md`(99行) + `pdf_extract.py` | ⚠️ 中等。有 3 check + 输出契约(`\`\`\`review`), 有 helper，但结构是"指导文档"式，无 schema 化 waypoint/checkpoint | **无 tests/ 目录** |
| **stats-integrity** | `SKILL.md`(91行) + `stats_integrity_check.py` | ⚠️ 中等。确定性门禁示例（`\`\`\`review` 输出），但仅限"flag risk" | **无 tests/ 目录** |
| **scientific-problem-selection** | `SKILL.md`(132行) + `tests/{skill-content.test.ts, fixtures.json}` | ⚠️ 有结构化输出块(`MINIMAL CLAIM:...`)，是"对话式框架"非工作流 | 4 tests |
| **single-cell-rna-qc** | `SKILL.md` + `single_cell_rna_qc.py` + `tests/{skill-content.test.ts, single_cell_rna_qc_test.py, fixtures.json}` | 🟡 范例级（唯一同时有 vitest + pytest 的 skill） | 4 vitest + pytest |
| figure / publication-figures | `SKILL.md`(+`pi_science.mplstyle`) | 图样式类，浅 | 无 test |
| latex-pdf / pdf-explore | `SKILL.md` + tests | latex-pdf 有 9 tests；pdf-explore 仅 fixtures | latex-pdf 9 个 test |
| band-structure-analysis / materials-phase-analysis / molecule-qc | 仅 `SKILL.md` + `fixtures.json` | 领域浅 skill | 无 .test.ts |

**关键结论**：`skills/skill-contract.test.ts`（4 tests）对目录名/license/entrypoints/description 做强制契约；各 skill 自己的 `tests/*.test.ts` 会被 `test:skills` 一起发现。**三大拟深化 skill 中，figure-composer、traceability-review、stats-integrity 目前都没有 skill-content 测试**（figure-composer 只有无人消费的 fixtures.json，后两者连测试目录都没有）。

---

## 2. Research Loop 机制（`apps/server/src/research-loop/`）

### 2.1 持久事件（durable events）
- **append-only event log**：`.pi-science/research-records-v2.jsonl`（`repository.ts:19`）。`ResearchRecord` 带 `schema_version:2 / record_id / record_type / workspace_id / loop_id / candidate_id / operation_id / run_id / created_at / producer / causation_id / correlation_id / payload`（`types.ts:7-21`）。
- 事件类型：`loop.created / loop.updated / loop.state_changed`、`agent.run_*`、`candidate.*`（`*_reserved/*_started/proposed/execution_*/evaluated/diagnosed`）、`evaluator.registered`。
-增量解析缓存**：`readResearchRecords`（`repository.ts:63-97`）按 `(size, mtimeMs, ino)` + 尾字节 anchor（64B）判断 append-only，只解析新增字节区间，不支持在写时即触发（但通过 `withFileWriteLock` 串行化写）。
- **进程内事件总线**：`events.ts` 只做跨进程/SSE 转发（`subscribeResearchEvents` → `project-routes.ts:94` 的 `/api/project-memory/research-events` SSE），是**失效通知**通道，非权威状态。

### 2.2 状态机与 reducer
- `reducer.ts:13-86` 把事件流 `reduce` 成 `ResearchSnapshot { loop, candidates[], operations[], records[] }`；`listReducedLoops` 按 `loop_id` 分组。
- 状态机 in `coordinator.ts:113-120`，状态枚举见 `contracts src/index.ts:381-384`：`draft→ready→running→pausing→paused→cancelling→cancelled→completed→failed→needs_attention`。

### 2.3 预算与停止条件（`stop-policy.ts:9-52`）
- 停止原因：`candidate_budget_exhausted`（`max_candidates`）、`wall_time_budget_exhausted`（`activeWallMs`）、`model_token_budget_exhausted`/`cost_budget_exhausted`（聚合 agent.run + evaluation 消耗）、`target_metrics_reached`（仅**确定性** metric 且全部达到）、`patience_exhausted`（`patience` 轮无改进且 < `min_improvement`）。
- 预算字段（contracts `researchBudgetSchema`）：`max_candidates/max_wall_seconds/max_model_tokens/max_cost_usd/max_parallel(固定1)`。`stop_conditions`：`target_metrics/patience/min_improvement`。
- **严格限制**：MVP stop 只支持 `builtin:result-json` 确定性 evaluator（`coordinator.ts:350, 639`），`llm_judged` metric 被 preflight 拒绝（`coordinator.ts:638`）。

### 2.4 计划步骤（plan steps）— **现在是显示性的，非可执行 checkpoint**
- `intent.ts:57-87` 的 `compileResearchIntent` 为 5 种 task_type 生成 `plan_steps`（一串指令文本，如"Change one justified factor per round..."）。但 **`plan_steps` 只存在于前端草稿卡片显示**（`ResearchLoopDraftCard），后端 loop 对象（`researchLoopSchema`）**没有 `plan_steps` 字段**，也没有按步骤推进/恢复的逻辑。
- 工作流式类型：`compare/evaluate/reproduce` 通过 `conversation_prompt` 注入代理系统提示（`intent.ts:84,132-135`），**不走 serial 迭代循环**；仅 `research_loop/optimize` 进入闭环（`coordinator.ts`）。

### 2.5 人工确认点
- **仅一处强确认**：创建 loop 前的 `intent` → 前端 `ResearchLoopDraftCard`（`ResearchLoopControls.tsx:17-35`）让用户确认 objective/成功准则/预算/计划后再 `createLoop`。对迭代型 `requires_confirmation: true`（`intent.ts:70`）。
- **运行中无阶段级人工确认**。loop 全程 `running` 自动推进（`coordinator.ts:162-198` drive 循环），只有 `pause`（等当前 phase 完成）、`cancel`（停 active work）、或失败转 `needs_attention`（`coordinator.ts:614-619`，等待用户 `resume`）。**没有"阶段产物 → 用户审批 → 进入下一阶段"的 gate**。

### 2.6 恢复
- `reconcile()`（`coordinator.ts:152-154`）在 API 访问时对非终态 loop 调用 `resume`；`drive` 循环里 `recoverInterruptedWork`（`coordinator.ts:439-492`）对 `reserved/started` 的 agent/execution/evaluation 重查状态：agent 丢失→记 failed+幂等重试；job 存在→按终态 reconcile。idempotency_key 贯穿（`generateCandidate` 的 `candidate:N`）。

### 2.7 候选快照与执行沙箱
- `candidate-snapshot.ts:30-79`：候选源文件→sha256 digest→**只读不可变快照**于 `.pi-science/solutions/<candidate_id>/`，入口 0o555，其它 0o444；注入 `PI_SCIENCE_OUTPUT_DIR`.
- 执行经 `JobCoordinator`（`coordinator.ts:302`），`PI_SCIENCE_OUTPUT_DIR/RUN_ID/CANDIDATE_ID` 环境注入；评价用 `builtinEvaluatorSource` 读 `result.json`（`coordinator.ts:712-731`）。

### 2.8 前端（`ResearchLoopControls.tsx`，50 行）
- `ResearchModePicker`（5 模式按钮）、`ResearchLoopDraftCard`（确认步骤）、`ResearchLoopStatusCard`（状态 + pause/resume/cancel/details + 最新 metric）。**没有**"阶段 waypoint 列表/人工确认按钮/checkpoint 恢复"等 UI。

---

## 3. skill seeding 流程（`pi-runtime-launch.ts:160-208`）

- `seedWorkspaceAssets(cwd)`：建 `.pi-science`; 复制 `harness/AGENTS.md`（可选）；把 `skills/` 整棵树镜像到 `cwd/.pi/skills/`（`seedSkillTree` 160-181, 229-267）。
- 安全要点：拒绝 symlink（`replaceForeignEntry`/`removeUnlinkable`）、`removeStaleEntries`（282-320）清理无上游对应文件（**警告：`.pi/skills/<builtin>/` 是完全托管区**）。
- 通过 `--skill <path>`（`pi-runtime-launch.ts:85`，RPC 模式把 seeded 列表放最前）。目录与 `catalog` 的 project 扫描根(`.pi/skills`)一致（`skill-catalog.ts:326`）。

---

## 4. skill 测试机制现状

- `pnpm test:skills` → `pnpm --filter @pi-science/server exec vitest run --dir ../../skills`（根 `package.json:12`）。
- **实测通过**：5 个 test files / 28 tests（我实际运行确认）：`skill-contract.test.ts(4)`、`literature-review(7)`、`scientific-problem-selection(4)`、`single-cell-rna-qc(4)`、`latex-pdf(9)`。
- `backend/services/skill_eval.py` **不存在**——只有 `literature-review/tests/skill-content.test.ts` 的注释提到 "Mirrors backend/services/skill_eval.py trigger semantics"。前端 evaluator 语义由 vitest 内联实现（token 化 + `trigger_terms` 命中）。
- fixtures 约定：`{prompt, expected_trigger, trigger_terms, required_outputs, produced_outputs}`；`workflow-fixtures.json` 额外校验 `required_outputs ⊆ produced_outputs`。仅 literature-review 有 workflow-fixtures。
- Python 侧：`single-cell-rna-qc/tests/single_cell_rna_qc_test.py` 走 pytest；`traceability/pdf_extract.py`、`stats_integrity/stats_integrity_check.py` **均无 Python 单元测试**。
- research-loop 服务器测试：`events.test.ts(3)`、`repository.test.ts(6)`、`research-loop.test.ts(21)`。

---

## 5. 与方案 4.3 的差距（Gap Analysis）

对照 4.3 要求的"每个深 Skill 至少包含"8 项，目前核心 skill 差距如下：

| 4.3 要求 | literature-review | figure-composer | traceability-review | stats-integrity |
|---|---|---|---|---|
| 明确输入/输出 schema | ⚠️ 有强制 citation 输出契约，但无 JSON schema | ❌ 无 | ⚠️ 有 `\`\`\`review` 输出块 | ⚠️ 有 `\`\`\`review` 块 |
| 阶段性 artifact | ❌ 仅"review artifacts"文字清单 | ❌ | ❌ | ❌ |
| **可恢复 checkpoint** | ❌ | ❌ | ❌ | ❌ |
| **人工确认点** | ❌ | ❌ | ❌ | ❌ |
| 科学有效性条件 | ⚠️ "必须 retrieved/fail-open" | ❌ | ⚠️ "只验证 traceability 非正确性" | ⚠️ 门禁覆盖范围 |
| 常见失败模式 | ⚠️ 含 provider 失败处理 | ❌ | ⚠️ 含 offline/不 resolve | ⚠️ |
| **收敛与停止条件** | ❌ | ❌ | ❌ | ❌（门禁类天然无收敛） |
| characterization/eval 测试 | ⚠️ 7 tests（含 workflow-fixtures） | ❌ 无 | ❌ 无 | ❌ 无 |

结构级缺口（共同）：
1. **全代码库无 `waypoint`/可恢复 checkpoint 概念**（唯一命中是 Jupyter `.ipynb_checkpoints`）。Research Loop 有事件日志+幂等恢复，但**不能细分到 skill 阶段**——它是"候选迭代"模型（propose→execute→evaluate→analyze），不是"多阶段 SOP"模型。
2. **Research Loop 无 `plan_steps` 持久化**，无法按阶段恢复；技能阶段之间无人工 gate。
3. Research Loop 停止条件是**确定性 metric 定量收敛**；literature-review/figure-composer/traceability-review 多是 qualitative/审阅类流程，**不产生 `result.json` 数值 metric**，与现 evaluator 模型（`builtin:result-json`）不匹配，选型上需要 new task type 或非迭代 workflow 支持。
4. **唯一的人工确认点只有建 loop 前**；阶段确认不存在。
5. `figure-composer`/`traceability-review`/`stats-integrity` **零技能级测试**。

---

## 6. 实现建议

### 6.1 深化哪 2-3 个 skill
推荐按"最成熟 + 与 Research Loop 复用度 + 用户可感知闭环"排序：

1. **literature-review**（第一优先）— 已最成熟（网关/评审产物/citation 契约/测试），深化成本最低。可定义：input schema（evidence question + scope + inclusion/exclusion 标准）、phase（检索 → 去重 → screening → 证据表 → 综合 → 引用校验）、每 phase 一个 schema 化 waypoint、收敛条件（检索饱和/覆盖率）、人工确认点（screening 采纳/剔除、最终论文范围）。
2. **figure-composer**（第二优先）— 正对 reverse_cs 的 figure-composer 工作流深度。阶段：claim 解析 → 布局计划 → 逐 panel 生成 → 合成 → visual QA → 对抗式 review。收敛=只重做失败 panel + 最大轮数。
3. **traceability-review**（第三优先）— 有 helper 与 3 check，适合做成阶段化 SOP：PDF 提取 → citation audit → numbers audit → figure↔code audit → 汇总 review 块。但**本质是单次审阅（非迭代收敛）**，更适合"阶段化 waypoint + 人工确认每 check"，而非闭环迭代。

> 不建议把 stats-integrity 做深（它是"运行期 gate"而非"长流程 SOP"，无收敛概念），可保留为 gate 工具被其它 skill 调用。

### 6.2 怎么复用 Research Loop
当前 loop 是"候选迭代"模型，**不能直接承载多阶段 SOP**。两种路线：

- **路线 A（轻量，推荐先行）**：在**技能内部**（SKILL.md + helper schema 文件）引入阶段 waypoint + checkpoint 格式，由 agent 自身把 waypoint 写为 workspace 内 schema 化 JSONL（如 `.pi-science/sop/literature-review/waypoints.jsonl`，仿 `research-records` 恢复），辅以 `\`\`\`checkpoint`/`\`\`review` 信息块。恢复=重新读取 waypoint 日志定位上一阶段。**不动 Node 控制面**。这是最低风险、可立即可逆的起步。
- **路线 B（全面，后续）**：给 Research Loop 增加新的 `task_type`（如 `workflow`/`sop`）或 `plan_steps` 持久化，让 Node 权威管理阶段状态与预算；每个阶段存 `reserved/started/completed/failed` 事件（复用 `ResearchOperation`/reducer/`recoverInterruptedWork` 幂等模式），并加 `phase_pending_approval` 人工 gate（仿 `needs_attention` 的 `resume` 语义，但按阶段）。这才能达成"可导航、可恢复、可审计"的完整目标，但改动 surface 大（coordinator+contracts+前端+ADR）。

建议：**先做 6.1 的 3 个 skill 的"waypoint 契约"文档 + fixtures + 测试（路线 A）**，把 skill 的 schema、artifact、失败模式、收敛条件先用纯 SKILL.md + schema 文件固化并立测试；Node 侧复用作为**第二个里程碑**（路线 B）——这正是设计文档 14.3 列为后续非目标的两阶段方案的精神。

### 6.3 风险点
- **停止条件错配**：现状 evaluator 只认 `result.json` 确定性数值 (`coordinator.ts:639,712`)；定性的 SOP（文献综合、figure QA、trace 审阅）无法产生数值 metric。若强行接入迭代 loop 会卡 `evaluatorBlockers`。→ 方案：阶段 waypoint 的"收敛/完成"用**结构化检查项通过数**或**人工确认**表达，或扩展 evaluator 支持"checklist evaluator"。
- **`.pi/skills/<builtin>/` 完全托管+孤儿清理**（`removeStaleEntries`）：任何给 skill 新增的非脚本文件必须放在 skill 目录内（seed 会全量镜像），不能放 `.pi/skills` 顶层。
- **license 纪律**：新增 schema 文件/helper 若借鉴 reverse_cs 需单独核查许可（当前都是 Apache-2.0 自研，无需担心复用，但 PDF 提取正则等需注意）。
- **测试基线必须先立**：依照设计文档 §"characterization 测试先行"。为 figure-composer/traceability/stats 先补 skill-content 测试，再改结构，保证 `pnpm test:skills` 全程绿。
- **恢复幂等依赖 idempotency_key + 事件唯一性**（`repository` append-only + `locked()` 串行写锁），新增阶段事件必须沿用同一 key 约定，避免写重复。

---

## 7. 相关测试清单（现存 + 需新增）

**现存可直接依赖/需要更新的：**
- `skills/skill-contract.test.ts` — 全局契约（若新增 schema 文件会被 digest/描述预算校验，需保持 entrypoints 准确）。
- `skills/literature-review/tests/skill-content.test.ts` (7) — 现有内容断言，深化后需同步。
- `skills/scientific-problem-selection/tests/skill-content.test.ts` (4)、`skills/single-cell-rna-qc/tests/single_cell_rna_qc_test.py`、`skills/latex-pdf/tests/skill-content.test.ts` (9)。
- `apps/server/src/research-loop/{events,repository,researchtest.ts` (3+6+21)。
- `apps/server/src/catalog/skill-catalog.test.ts` — catalog 解析/发现/seed 相关。

**需新增（深化后）：**
- `skills/figure-composer/tests/skill-content.test.ts`（断言方式：输入/输出 schema、panel 布局、QA 轮数上限、artifacts 校验）+ fixtures 扩展。
- `skills/traceability-review/tests/skill-content.test.ts` + `fixtures.json` + `pdf_extract.py` 的 pytest。
- `skills/stats-integrity/tests/...`（`stats_integrity_check.py` 的门禁正则 pytest + skill-content vitest）。
- 每个深 skill 的 `workflow-fixtures.json`（内容级 required/produced outputs）——现仅 literature-review 有。
- 若走路线 B：`apps/server/src/research-loop` 为 `plan_steps` 持久化、阶段人工 gate、SOP evaluator 各加单元测试。

---

## 关键文件速查（供实现定位）

- 设计文档 4.3：`docs/reverse-cs-inspiration.md:95-107`；本 PR 明确未实现深工作流：`docs/reverse-cs-inspiration.md:310-314`。
- Research Loop：`apps/server/src/research-loop/{coordinator,reducer,stop-policy,repository,intent,candidate-snapshot,events,subagent-runner,types}.ts`; 路由 `apps/server/src/http/routes/project-routes.ts:101-111`。
- 前端 loop 类型/API：`frontend/src/lib/knowledge/project-memory.ts:25-176`；控件 `frontend/src/components/conversation/ResearchLoopControls.tsx`。
- ：`packages/contracts/src/index.ts:346-474`（research）、`476-583`（skill metadata）。
- skill seeding：`apps/server/src/runtime/pi/pi-runtime-launch.ts:160-320`; catalog `apps/server/src/catalog/skill-catalog.ts`。
- ADR：`docs/adr-research-loop-subagents.md`；作者指南 `docs/skill-authoring.md`。

**整体结论**：Research Loop 已具备事件持久化 + 幂等恢复 + 预算 + 建前确认 + 取消/暂停，是优质的底层基础设施；但它是"候选迭代优化"模型，**缺"多阶段 SOP / 阶段 checkpoint / 阶段人工确认"语义**，且核心审阅类 skill（figure-composer、traceability、stats）既无 schema/waypoint 也无任何测试。方案 4.3 的最佳切入点是：先以 SKILL.md + schema 文件 + fixtures 固化 2-3 个深 skill 的 waypoint 契约并补测试（不改 Node），再作为第二个里程碑把 Research Loop 扩展为按阶段 checkpoint + 人工 gate 的通用可恢复 SOP 载体。
