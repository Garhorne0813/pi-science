# Pi-Science 重构与演进方案

> 状态：待批准。生成于 2026-07-26，基于 commit `8df6a57`（绿色基线：264 TS 测试 + 50 pytest + CI + 4 UAT 脚本全通过）。
> 本文档是后续执行 agent 的唯一作业依据；执行时逐批进行，每批独立可构建、可测试、可回滚。

---

## 1. 项目定位（重构北极星）

Pi-Science 是 **local-first 科学 AI 工作台**：对话式科研助手 + 可复现计算执行 + 自主研究循环 + 项目知识沉淀。三进程架构：

- **React SPA**（frontend/）— 唯一 UI
- **Node 控制平面**（apps/server/）— 唯一状态权威：会话、任务、研究循环、设置、工作区安全
- **Python 科学运行时**（backend/）— 仅内核/notebook 执行与文件解析
- 每个对话一个独立 **Pi agent 进程**（runtime/pi/，fetch 而来）

由定位推出的三条硬约束：
1. **Node 是唯一控制平面** — Python 不再承载任何业务状态；它是可替换的执行服务。
2. **可复现性是差异化** — provenance / 确定性评估 / 引用溯源必须可见、可信、有测试。
3. **Local-first 单用户单机** — 不引入分布式复杂度，但单机崩溃恢复必须可靠（已有孤儿 job 自愈等）。

## 2. 基线（重构前必须固化）

现有验证资产（Batch 0 将写入 docs/refactoring-baseline.md 并补缺口）：

| 资产 | 现状 | 缺口 |
|---|---|---|
| TS 测试 | 264（contracts 2 / server 117 / frontend 145） | 文献技能测试在 vitest 收集范围外 |
| pytest | 50（58% 覆盖存活面） | 旧文档声称 288 是删除前缓存，须更正 |
| typecheck | contracts + server | **前端无 typecheck script，root/CI 不含前端** |
| CI | .github/workflows/quality.yml | 同上 |
| UAT | 4 个脚本（conversation/knowledge/notebook/office） | 未进 CI |
| 组件测试 | **零**（无 .test.tsx，无 testing-library；jsdom 已配好） | 见决策 D1 |
| smoke | scripts/smoke-control-plane.sh | — |

## 3. 问题清单（证据在案，按级别）

### P0 — 正确性/安全（先于一切结构移动，单独批修复）

| # | 问题 | 证据 |
|---|---|---|
| P0-1 | **auto-review 静默失效**：Node 仍 POST `${pythonOrigin}/api/sessions/{id}/auto-review`，该端点已随 NCP-029 删除，错误被 `.catch(()=>undefined)` 吞掉 | apps/server/src/node-session-service.ts:527-535 |
| P0-2 | **workspace 安全校验双实现漂移**：Python 侧仍依赖无人写入的 `~/.pi-science/workspaces.json` 注册表；Node 侧用 marker 目录规则。两者可对同一路径给出相反判定 | backend/services/workspace_security.py:15 vs apps/server/src/workspace-security.ts:4-22 |

### P1 — 架构债（分批处理）

**服务端/Python：**
- ~1,320 LOC 确证死 Python：`models/` 大部分（仅 kernels 用到 5 个类型）、`services/skill_catalog.py`(322)+`skill_eval.py`(53)（已移植 Node）、`pi_science/cli.py`(128)、config.py ~50 行死配置、`backend/scripts/pi_model_capabilities.mjs`（孤儿）
- 零调用端点：`POST /api/figures/compose`（且是 Python 侧 artifact_store/provenance_store/workspace_journal/telemetry 的唯一消费者，Node 已有同款实现）、`POST /api/literature/search`（被直连技能取代）、`POST /api/pdfs/index`（前端只用 /search）
- `CellResult` 双定义（models/__init__.py:263 pydantic vs kernel_manager.py:20 dataclass）
- `models/__init__.py` 急切 re-export 拖入全部死模块

**前端数据层（5 套机制并存）：**
- `apiRequest`（带缓存/去重/重试）只有 6 个文件在用；**30 处裸 `fetch`**（SettingsPage 独占 17 处）无重试无缓存
- 4 套错误解析（api.ts / settings-api.ts / pi-science-client.ts / notebook-runtime.ts）；4 种错误 UX（吞掉/页级 error/toast/硬编码英文）
- 缓存 TTL 不一致（3s vs 5s），失效逻辑双层散布
- 3 套 SSE 实现（conversation hub 带游标/watchdog、research 防抖失效信号、NotebooksPage 内联无 try/catch）+ 2 个轮询循环

**前端状态：**
- **cwd 三个事实来源**：useParams 派生 ×8（fallback 不一致）+ runtime-store.cwd + files.ts:20 模块全局 `_currentCwd`
- model/thinking 在 store 与 LiveSessionPage 本地状态双份，靠 effect 镜像
- LiveSessionPage.tsx:37 整店订阅 → 每个流式 token 全页重渲染
- 模块级可变全局：slash-commands.ts:20、runtime-store.ts:99-100

**巨石文件（行数 + 内嵌组件数 + 职责数）：**
- SettingsPage.tsx 1523（13 内嵌组件；`LLMTab` 参数 `: any` 类型洞；4 个本地 interface 重复服务端 DTO）
- runtime-store.ts 1425（7 类事件折叠 + 线程模型 + 恢复 + 导航副作用）/ 其测试 1197
- i18n/index.ts 1129（双语言 548 键内联平铺）
- KnowledgePage.tsx 1005（12 内嵌组件、14 个 useState、4 个独立 loader）
- LiveSessionPage.tsx 867（9 类关注点 + 8 内嵌渲染组件）
- pi-science-client.ts 825（名称注册表 + 消息缓存 + REST + SSE 传输 4 合 1）

**i18n：**
- 13 个 UI 文件完全未接 i18n（SkillsPage 整页、ConversationWelcome、ErrorBoundary、NotebookEditor 等）
- 15+ 处硬编码用户可见字符串（含 lib 层 throw 出的英文直显给用户）
- 覆盖测试可被动态 key 构造绕过（已有 10 个逃逸名单）

**测试形状：**
- **8 个科学格式解析器（lib/viewers/：fits/genome/dos/bands/molecule/phase/anomaly/qcode）零测试** — 项目最差异化、最易错的纯函数裸奔；而它们的 9 个一行 re-export shim 反而是被 import 的对象
- 5 个最高风险未测 UI 行为：composer 发送失败恢复、IME 中文输入 Enter 守卫、auto-preview 触发状态机、model 切换乐观回滚、slash 命令分发器

### P2 — 耐久性/质量（后批）
- withFileWriteLock 仅进程内；`.research-loop-lock` 从未真正持有（双 server 实例损坏事件日志）
- 研究事件日志无界增长 + drive 轮询全量重读；无 snapshot/增量读
- JobCoordinator SIGTERM 杀不到孙进程（bash→sleep 拖 shutdown ~28s）；需 detached + 进程组 kill
- 失败 agent run 的 tokens/cost 不入账（预算低估）；get_session_stats 每次 state() 多一跳 IPC
- modelCatalog 合并顺序让 custom fallback 覆盖 runtime 条目
- 前端死代码：CompactSelect.tsx 整文件、files.ts 4 个 Tauri 残留导出、artifacts.ts 6 个无用导出、useOverlayTitlebar 恒 false、THINKING_LEVELS、loadProvenance、parseDelimited、9 个 re-export shims（chart.ts 零直接引用者）
- `Section`/`EmptyState` 双处独立定义
- components/inspector/ 19 文件混三类（chrome/科学渲染器/领域面板）；6 个单文件目录

### P3 — 风格（**明确不做**）
- 仓库的超长单行密度风格是刻意选择：保留，不做全仓格式化，不当作重构目标
- 不为假想的未来需求引入抽象

## 4. Track B — 产品功能路线图（与重构严格分离，Phase 4 执行；2026-07-26 用户批准全量）

按执行顺序（价值 × 基建杠杆排序）：

**B-1 参数扫描模式（Sweep）** — 研究循环的确定性兄弟：用户定义参数网格/随机采样，复用 JobCoordinator + 评估器 + frontier 全套机制（复用率 ~90%），出对比表；可与 LLM 循环混合（LLM 分析 sweep 结果提下一轮网格）。全 Track 性价比最高，先做。

**B-2 可复现性双子星**（差异化主线，共享 provenance 主线）：
- **Claim Ledger 证据链看板**：「结论」成为一等公民对象，挂证据链（run→artifact(sha256)→文献(DOI)→评估结果），状态：已支持/被反驳/未验证。把躺在 jsonl 里的 provenance 变成产品灵魂。
- **Repro Pack 复现包导出**：一键打包 run/循环为可复现 bundle（代码快照+环境 lockfile+数据引用+provenance 链+README 生成）→ zip/git 仓库。候选快照机制已是半成品。
- 并入原有：provenance 链路 UI、结果审查工作流（result_review_count 恒 0）。

**B-3 研究循环深化**：candidate.diagnosed 分析展示、预算/成本进度条、候选下钻（stdout/artifacts/源码）、loop 编辑/归档/删除、LLM 化 intent（现硬编码 metric="score"）、评估器管理复用。

**B-4 研究报告自动生成**：循环结束后从事件日志（候选/指标/分析/frontier）生成结构化报告，document 排版纸样渲染导出。与 B-3 配套。

**B-5 数据集画像**：拖入 CSV/NetCDF/FITS 自动跑 kernel 出画像卡（schema/分布/缺失值/快速图表），复用检查器 12 种预览器。

**B-6 Subagent 评审家族**（与 D2 的 auto-review 同构）：
- auto-review 知识回流闭环（A1 修触发，此处做完整体验）
- **统计审查工作流**：stats-integrity 技能做成一键动作——报告/知识入库前独立 subagent 审统计有效性（p-hacking/样本量/多重比较）。

**B-7 基础体验补完**：会话管理（重命名/置顶/搜索/删除）、文献 MCP 连接器 + 引用验证真实现（现恒 unverified stub）、知识 file views 真实现（现空 stub）、file-operation undo 真实现。

**B-8 PDF 证据互链**：对话/知识条目可引用「某 PDF 第 N 页」为证据，点击跳转高亮（pdfs/search 已能定位页）。

**B-9 远期**：Git 工作区版本化（每轮次自动 commit + provenance 关联 message、时间旅行）、评估器库 + 跨循环排行榜、定时/文件监听重跑、研究模式差异化（optimize/compare/evaluate/reproduce 现仅改 placeholder）、并行候选（ADR 预留）、LLM-judged metrics。

### 4.0 评测基准存档（2026-07-26 调研；用户裁定：暂不实施，仅归档备查）

若未来要对外出数字，行动顺序已定：① 写一个 Inspect AI solver 桥接层（`sandbox_agent_bridge` 就是为 CLI agent 设计的，照抄 inspect_swe 的 claude_code 模板）——一次投入解锁 AstaBench + inspect_evals 内的 core_bench/scicode/lab_bench/mle_bench 等一整批；② AlgoTune（CPU-only，~$150）本地打通「基准 grader → `evaluator.command` → Pareto 循环」；③ SUPER Expert（2-3 美分/题）验证可复现性面；④ DABstep 验证对话式数据分析；⑤ 有算力再上 RE-Bench（其 intermediate_score/取历史最优的协议与我们的预算+frontier 模型天然同构）与 MLE-bench Lite。
关键结构性优势（可用于叙事）：`evaluatorSpecSchema.command` 可直接装载任意基准的 grader——研究循环即插即用地变成基准优化器。避坑名单：GUI 类（ScienceBoard/Spider2-V/OSWorld，无 computer-use 通道）、CURIE（已归档且纯长上下文）、GAIA/GAIA2（浏览器依赖/强制 Python 基类）、RepliBench（同名陷阱：测的是自我复制安全）、MLR-Bench（纯 LLM rubric 无确定性）。完整报告见会话记录（40+ 基准横评）。

### 4.1 调研修正（2026-07-26 R1 科研工作流实证调研，证据见调研报告）

**新增功能（证据直接支撑）：**
- **论文结论复算器（Claim Verifier）** → 并入 B-2 并使其成为主打：从论文表格/补充材料抽数据→生成分析代码→本地内核复算→输出「与作者结论一致/不一致」。这是唯一 Elicit/NotebookLM 在架构上无法跟进的能力（它们没有执行引擎），也是最大空白（HN 实证："LLM 对作者主张过于轻信"）。
- **AI 方法学附录自动生成** → 并入 B-2：从 provenance 日志一键生成「本研究中 AI 的使用方式」章节。对应 AI 污名恐惧（实证）+ 73% 研究者要规范；可能是转化率最高的单一功能——把 AI 从合规风险变成方法学加分项。
- **PRISMA-ready 检索记录** → 并入 B-2/文献侧：每次文献检索自动落库检索式/数据源/时间戳/纳入排除决策，可导出检索附录。三家图书馆对 Elicit/Consensus/ResearchRabbit 的一致否定结论 = 无人满足的合规刚需；复用 research-records 基建，工程量小。

**Hyra-1.0 借鉴（2026-07-26 调研；腾讯混元 Research Agent，2026-07-20 发布——无人值守优化引擎，与我们的研究循环骨架同构但无 UI/文献/知识库/本地部署，不构成产品竞争；证据一手 README + 多源交叉）：**
- **Experience Bank** → 并入 B-3 提升为核心项：在 event-sourced run 记录之上加检索型经验层（方案/代码/日志片段/得分/成败标签/失败根因），propose 阶段注入跨 run 跨项目 top-k 相关经验（**含负例**）。数据已在 provenance 里，缺的只是索引层——借鉴性价比第一
- **异步生产者-消费者并行 proposal 池** → 替代 B-9 的"并行候选"条目并前移到 B-3 档：Context/Proposer 产提案入队，N 个 Executor 并发（各自 kernel 沙箱，本地默认 2-4），事件溯源架构与队列天然同构；风险点：并发写 workspace 需每 proposal 一个工作副本
- **评估器共进化双层循环** → 新增 B-3 子项：无 deterministic evaluator 的任务由 agent 起草/升级评估器——**我们的落地比 Hyra 保守**：evaluator 升级走已有 review inbox 人工确认（复用人工审阅闭环，防 reward hacking，Hyra 官方承认弱评估器会被 hack）
- **Rubric 化 LLM/VLM 评估器** → 上一条的具体形态：结构化多维评分卡（可复现/可 diff/可版本化），补齐图表/图像/文本产物的自动评估
- **研究结果卡** → 并入 B-4：`指标精确定义 | prev-best 数值+出处(DOI 自动检索) | 本次结果 | 快照日期 | 自包含复现脚本 | 全链路 sha256`——把我们已有的 provenance × 文献检索两个能力相乘，做出 Hyra 做不到的「自动带文献对标的可复现结果卡」
- 小项：自主判停（marginal-gain 停止，补预算之外的第二停止维度）；Hyra-results 仓库（Apache-2.0）的任务集可作研究循环的回归自检题库

**外部内容接入设计（2026-07-26 三轮调研定稿；深度裁定：Zotero L2 薄实现 / Obsidian「打开而非导入」）：**
- **Obsidian = 就地打开**：vault 就是文件夹、我们的工作区就是文件夹——检测到 `.obsidian/` 即进入 vault 模式（默认只读），**零复制零转换**（file-over-app 是该社群的共识文本，「导入」对 local-first 用户是反向信任信号；Obsidian 官方连自家导入器都不亲自维护）。配「Obsidian 感知」派生索引：frontmatter(gray-matter) + wikilink 图(remark-wiki-link) + 块锚点表 + Dataview inline fields(自写小解析器) + `.canvas` 图谱(JSON Canvas 1.0，20 行 TS 自解析)。一次性导入只留一个窄场景：选中若干笔记摘进知识库（走 review inbox）。**⚠️ 前置条件：vault 模式下 `.pi-science/` 派生数据必须移出 workspace 根**（否则高频 JSON 落进用户的 iCloud/Dropbox 同步目录 → 冲突文件污染 vault）——这是接入前必须做的架构小改
- **杀手细节——vault 里的 Zotero 文献笔记可精确识别**：科研用户的 vault 笔记多由 Zotero Integration/Citations 插件按模板生成，启发式（frontmatter `citekey`/`zoteroKey`、`@` 前缀文件名、`zotero://` URI、`%% begin notes %%` 区段）可打标后与 Crossref join → 用户既有文献库直接变成我们的文献图谱种子。**红线：`%%...%%` 注释区是插件的「重导入不覆盖」保护区，写回时绝不可剥离（会静默毁掉用户手写笔记）；默认不写回文献笔记**
- **Zotero**（前述裁定不变）：L1/L2 走本地 HTTP API + BBT 增强，设置页连接卡片按 collection 授权；L3 只做「综述写回子笔记」（Web API）；MCP 预设推荐 cookjohn/54yyyu；sqlite 永不直读
- **Notion**：有损 zip 解析、如实告知（官方自认单向；Include Subpages 是 Business+ 专属；官方本地 MCP 已预告可能停服——不押注）；**Overleaf**：zip 拖入为默认（git 集成是付费墙），**只 pull 绝不 push**（官方承认 push 会毁 track changes/批注）；`.tex` 不转 markdown，建结构索引（章节树 + `\cite`→`.bib`→DOI join，复用 unified-latex 生态）；**Jupyter**：无需导入，索引时剥 base64 outputs + 用 `cell.id` 做锚点（@jupyterlab/nbformat）
- 库选型（实测数据在案）：gray-matter/remark-wiki-link/@unified-latex/citation-js/@jupyterlab/nbformat 为生产依赖；全 OFM 库（obsidian-ext）只借鉴不依赖；Obsidian MCP 只对接官方 Local REST API 插件内建者（第三方桥接前三名：一个 archived、一个停更 17 月、一个有 HIGH 安全告警）

**战略约束（路线图优先级层面）：**
- 关键数据：84% 研究者已用 AI，但对专用科研工具知晓率仅 11%，80% 在用 ChatGPT——**真正的对手是一个开着的 ChatGPT 标签页**。首次体验必须 5 分钟内展示 ChatGPT 做不到的事（复算/重跑），而非「我也能总结论文」。
- 「agent 进 notebook」是红海（marimo 等多个开源玩家）——内核执行是基建不是叙事；差异化必须落在 provenance + 研究循环 + 项目知识库。
- 隐私顾虑 47%→58% 上升、NotebookLM 云端条款劝退高校——**local-first 应升格为一等营销主张**（UI 可见的数据流向标注、Ollama/本地端点支持）。
- **MCP 反向分发**：把 pi-science 的执行/复算/provenance 能力作为 MCP server 暴露给 Claude/ChatGPT 用户——获客通道而非集成清单项（远期，B-9 档）。
- 佐证既有决策：57% 愿让 AI agent 自主执行科研任务（研究循环有需求基础）；Zotero+Obsidian 栈「组装痛/升级断裂」实证（薄集成方向正确——用户已有语料 BYO-corpus 优先，对出版商收窄公共索引免疫）。

## 5. 分批执行计划

> 每批模板：目标 / 允许修改文件 / 方法 / 风险 / 验证命令 / 完成标准。回滚 = git revert 单 commit。
> 不混功能与重构；不混行为修复与结构移动；每批一个 commit。

### Phase 1 — 加固（低风险，先行）

**B0 基线加固**
- 生成 docs/refactoring-baseline.md（全部验证命令 + 实际输出记录 + 已知警告清单）
- frontend 加 `typecheck` script（`tsc -p tsconfig.app.json --noEmit`），接入 root typecheck 与 CI
- 文献技能测试接入测试命令；更正旧文档的 pytest 计数
- 【D1】引入 @testing-library/react；为 5 个高风险行为写 characterization tests（固化现状，不修行为）
- 新建项目根 CLAUDE.md，写入 Refactoring rules（见 §7）
- 验证：CI 全绿 + 新测试通过

**A1 P0 行为修复**（是修复不是重构，独立批）
- P0-1 auto-review：【D2】Node 原生实现或明确删除（含 UI/设置残留清理）
- P0-2 workspace 安全统一：Python 侧对齐 Node 的 marker 规则，删除 registry 依赖；两侧共享测试夹具验证判定一致
- 验证：针对性回归测试先红后绿；全套件
- **A1 执行结果（2026-07-26）**：P0-2 已完成（13 场景双侧 parity 夹具，先红后绿）。P0-1 调查熔断触发：**手动 Review 按钮的 `/api/project-knowledge/review` 端点在 Node 和 Python 中都不存在**（NCP-029 连 reviewer 一起删了，请求落进代理返回 404/504）——无"触发链路"可修，整个 reviewer 需要重建 → 拉出独立批次 A1b。发现新 P2 缺陷：Node workspace-security 对 managed root 只做词法解析而对候选路径做 realpath，**managed root 在符号链接后面时未打标工作区会被误拒**——已由双侧 parity 测试钉住现状，修复必须两侧同步改（独立 ticket，勿在无关批次顺手修）。

**A1b 项目 reviewer 重建**（消化 Track B-6 前半，因 P0-1 调查提前）
- 一次实现、两处触发：`project-review` 模块 + `ReviewSubagentRunner`（subagent-runner 的轻量同款：buildPiProcessOptions、独立 session-dir、30s 请求超时、硬墙钟超时、响应字节上限、Zod 解析提案数组）+ Node 原生 `POST /api/project-knowledge/review`（手动按钮与 scheduleAutoReview 共用）+ 每会话每轮次防抖 + 失败记日志不再吞
- 测试：FakeRunner 模式（仿 research-loop.test.ts）——启用出提案/停用无动作/失败有日志无崩溃；路由测试
- 预计 1–1.5 天量级

**A2 Python 收缩**
- 删除 §3 P1 所列死 Python（models 裁剪至 kernels 所需 5 类型 + literature.py 若 D3 保留）、skill 服务、CLI、孤儿脚本、空目录、backend/package.json
- 【D3】删除 /api/figures/compose（连带 4 服务）与 /api/literature/search；【D5】/api/pdfs/index 去留
- 同步 runtime-boundaries.ts、pytest 清理（删死面测试，补 kernels HTTP 层与 internal-token 中间件测试）
- 修 CellResult 双定义
- 验证：pytest + smoke + Node app.test 代理契约 + UAT notebook 脚本

### Phase 2 — 前端骨架（串行为主）

**A3 数据层统一**
- 【D4 已裁定：TanStack Query】Query/Mutation 层接管 REST 的缓存/失效/重试/去重；统一错误解析与错误 i18n；废除 api.ts TTL 缓存与各 wrapper 的独立 TTL；research-events SSE 信号桥接为 queryClient.invalidateQueries；SSE 与 zustand store 不迁移
- **边界修订（2026-07-26）**：SettingsPage 内部的 17 处裸 fetch 不在 A3 迁移——A6 拆分 SettingsPage 时一并迁移（避免同一文件两批各动一次）；A3 覆盖其余全部裸 fetch 调用点与 6 个 wrapper 模块
- 验证：全套件 + UAT ×4（行为不变）

**A4 cwd 单源 + 订阅规范**
- WorkspaceContext（route param 派生一次，向下传递）；删除 files.ts `_currentCwd` 全局；统一 fallback 语义
- LiveSessionPage / RightPane 改 selector 订阅（顺带解决每 token 全页重渲染）
- 验证：全套件 + UAT conversation

**A5 LiveSessionPage 拆分**（B0 的 characterization tests 保驾）
- 渲染层迁出：InteractionPrompt/BlockRenderer/ToolGroup/UserMessage/AgentMessage/ToolCard/StatusLine → components/conversation/
- 逻辑 hooks 化：useResearchLoop / useComposer / useSlashCommands / useTurnEffects（auto-preview+suggestions）
- 行为不变；目标 LiveSessionPage < 300 行

**A6 SettingsPage / KnowledgePage 拆分**
- 每 tab 一文件（settings/ 与 knowledge/ 子目录）；消灭 `: any` 参数洞；合并重复的 Section/EmptyState
- 目标：单文件 < 400 行

**A7 runtime-store / pi-science-client 拆分**
- runtime-store → transport 折叠 reducer / thread 模型 / session actions / naming 四模块；测试文件同步拆
- pi-science-client → rest-client / sse-transport / session-name-registry / message-cache
- 行为不变；模块级可变全局收敛为显式状态

### Phase 3 — 质量与耐久

**A8 i18n 资源化**
- locales/en.json + zh-Hans.json（【D6】暂不做按需加载）；13 个未接文件补 t()；§3 硬编码清单全量落 i18n（含 lib 层 throw 的用户可见错误改错误码→UI 翻译）；覆盖测试强化

**A9 耐久性**
- 真跨进程文件锁（O_EXCL lockfile + 陈旧检测，或既有轻量库，倾向零依赖实现）
- 研究事件日志：按 offset 增量读 + 定期 snapshot 压实；drive 等待期轮询退避
- JobCoordinator detached spawn + 进程组 kill（修 28s shutdown 拖挂）
- 失败 run 计费入账；SSE 实现收敛（NotebooksPage 内联迁移到统一 helper）

**A10 死代码清理 + 科学解析器测试**
- §3 P2 前端死代码清单逐项删除（动态 import 的 pptx/xlsx 先验证再动）
- 9 个 re-export shims 收敛为直接 import
- **为 8 个 lib/viewers 解析器补齐单元测试（用真实样例文件夹具）** — 本批最重要的产出
- components/inspector 分目录：shell / viewers / panels

### Phase 4 — Track B 功能（§4，另立计划，逐项）

**并行规则**：A2 与 A3 文件不相交可并行；A5→A6→A7 串行（共享 characterization 测试面）；A8 与 A9 可并行。

## 6. 执行模式（Opus 5 subagents）

- **主会话**：调度、批间决策、冲突仲裁、跑完整验证、commit/push。执行 agent 不 commit。
- **每批流程**：executor agent（Opus 5，任务书含本文档相应批次 + 证据行号）→ 主会话跑全量验证（typecheck/test/build/相关 UAT）→ **verifier agent**（独立干净上下文，只审 diff vs 本计划与基线：行为是否改变、API/序列化是否变、是否漏调用方、是否引入循环依赖/不必要抽象、diff 是否混入无关改动；每发现给严重度/位置/触发条件/修法）→ 人工确认 → 单 commit。
- executor 报告规则：只报告本会话内命令/工具输出验证过的事实；未验证的明确写"未验证"。
- 假设失效即停：批内发现计划假设与代码不符，停止修改并报告证据。

## 7. 项目 CLAUDE.md 拟写入的 Refactoring rules

```
## Refactoring rules
- Preserve externally observable behavior unless the task explicitly requests a behavior change.
- Do not mix refactoring, dependency upgrades, formatting changes, and feature work in one change.
- Prefer small, reversible changes over repository-wide rewrites.
- Do not introduce abstractions for hypothetical future requirements.
- Inspect actual call sites before moving, renaming, or deleting code; treat reflection,
  plugin registration, configuration references, and dynamic import as potential call sites.
- Establish a passing test baseline before structural changes; add characterization tests
  first when behavior is insufficiently tested.
- Every refactoring batch must build, pass tests, and be reviewable/revertable independently.
- Before reporting success, verify every claim using command output from the current session;
  explicitly distinguish verified results, assumptions, and unresolved risks.
- Keep the repository's dense single-line style; do not reformat untouched code.
```

## 8. 决策点（2026-07-26 已由用户裁定）

| # | 决策 | 裁定 |
|---|---|---|
| D1 | 引入 @testing-library/react 组件测试基建 | ✅ **引入**（B0 执行） |
| D2 | auto-review | ✅ **Node 原生 + Pi subagent 实现**：复用研究循环的 subagent-runner 模式，独立评审 agent 读对话历史→产出结构化知识提案进 Knowledge Inbox（对齐 Claude 的项目知识回流）。A1 修复触发链路，完整实现归 Track B #6 |
| D3 | 删除 /api/figures/compose 与 /api/literature/search | ✅ **删**。澄清已确认：零调用=代码库不存在任何调用路径（非"暂时没用"），且均为功能重复（Node 同款 artifact/provenance；直连文献技能）。图像拼版若需要，正确形态是技能指令+内核执行 |
| D4 | 数据层 | ✅ **引入 TanStack Query**（用户裁定：技术上更成熟即做）。范围：REST GET/mutation 的缓存/失效/重试层；SSE 与 zustand store 不迁移 |
| D5 | /api/pdfs/index 去留 | 保留（默认推荐，未被否决） |
| D6 | i18n 按需加载 | 暂不 |
| D7 | Python 远期战略 | 保留为纯"内核执行服务" |
| D8 | docs/bug-review-remediation-{plan,prompt}.md | 待用户单独确认后再删（不并入任何批次） |
