# Pi-Science 原子级改进方案

> 对标基线：[`JimLiu/science-skills`](https://github.com/JimLiu/science-skills)，参考提交 `fb309c32ee9a54dad169fa845638057d1cfac77f`（检查日期：2026-07-18）。
>
> 目标：不照搬单一生物医药产品，而是吸收其“技能发现 → 工具调用 → 计算执行 → 产物交付 → 事实审查 → 可复现”的闭环，把 Pi-Science 从具备丰富功能的科研工作台升级为可扩展、可验证、可治理的技能驱动科研平台。

## 1. 执行结论

Pi-Science 当前已经具备 science-skills 仓库本身没有提供的完整产品外壳：Web 会话、工作区、Notebook、Python/R kernel、文件浏览、多种科学格式预览、产物溯源、运行记录和人工审批的项目知识 Reviewer。真正的差距不在基础 UI，而在以下六个连接层：

1. 技能目前“能扫描、能开关”，但还不是带 schema、依赖、许可、风险、版本、验证状态和运行证据的正式能力单元。
2. MCP 目前“能配置服务器”，但缺少工具级目录、健康检查、数据外发说明、许可信息和按技能绑定的最小权限。
3. 计算目前以本地 kernel 为主，缺少任务级环境声明、可移植执行契约、远程计算和模型端点抽象。
4. 文件已经有 provenance，但缺少统一的“用户可见产物发布”协议与产物级验收闭环。
5. 已有 Reviewer 聚焦项目知识提取，不等于对数值、引用、执行声明和最终产物的一致性审查。
6. 缺少技能创建、静态验证、触发准确率评测、工作流回归和质量分级体系。

建议优先顺序是：**技能底座 → 产物与验证 → 通用科研技能 → MCP 治理 → 计算抽象 → 专业 Agent 与技能评测**。第一阶段不应批量移植 science-skills 的 29 个技能或 87 个生物工具模块。

## 2. 现状证据与差距矩阵

| 维度 | Pi-Science 当前状态 | science-skills 可借鉴实践 | 判断 |
| --- | --- | --- | --- |
| 技能目录 | `backend/api/skills.py` 扫描 `SKILL.md`；Skills 页面只展示名称、描述、来源 | 统一 front matter，含 category、requirements、third_party、许可与服务条款 | P0：先升级元数据与目录模型 |
| 技能解析 | 手写逐行解析 `name`/`description`，不能可靠处理 YAML 折叠、多行和嵌套字段 | 大量技能依赖复杂 YAML 元数据 | P0：替换为严格 YAML schema |
| 技能运行 | 设置页可启停路径，Pi 启动时注入技能 | 描述驱动发现、按需加载、辅助脚本、references、requirements | P0：增加详情、能力检查、运行证据 |
| MCP | 可读取标准 MCP 配置并启停 server | 生物工具集合、化学 widget、工具按领域聚合 | P1：建设 connector/tool catalog，不直接全量 vendoring |
| 计算 | 本地 Python/R kernel、Jupyter、运行记录 | GPU requirement、环境模板、SSH/Slurm/Modal、模型 endpoint | P2：先定义 provider-neutral job contract |
| 产物 | 文件版本、环境快照、diff、对话来源已存在 | 强制保存产物、回读校验、图像渲染检查、结构文件专用展示 | P0：将现有 provenance 升级成 artifact publication |
| 文献 | 依赖 MCP 扩展，缺少产品内标准工作流 | literature-review 强调真实检索、撤稿检查、引用防幻觉 | P1：首个通用科研技能切片 |
| PDF | 已有 PDF inspector | pdf-explore 强调多页一次解析、检索和结构化抽取 | P1：从“看 PDF”升级到“研究 PDF” |
| 图表 | 表格图、科学 viewer 已有 | figure-style / composer 的 claim-data 检查、渲染 QA、多面板编排 | P1：形成出版级图表闭环 |
| Reviewer | 提取项目知识并经人工批准 | 独立 transcript reviewer 追踪数值、引用、执行和产物矛盾 | P2：新增只读结果审查器，保持职责隔离 |
| Agent | 依赖 pi-subagents 扩展 | onboarding、reviewer、bookmarker、operon 等 profile | P2：在产品层显式展示 profile 与权限 |
| 技能工程 | 无创建、打包、eval UI | skill-creator 自带静态验证、评测、对比和报告 | P2：建立技能 CI 与触发评测 |
| 前端性能 | 构建通过，但多个 vendor chunk 超过 500 kB | 无直接对应 | 独立治理，避免技能扩展继续放大首屏 |

## 3. 原子任务定义

每个原子任务应满足：单一主要行为、可独立评审、失败可回滚、具有明确输入输出、至少一个自动验收条件。建议每项对应一个小 PR；`S` 约半天，`M` 约 1–2 天，`L` 约 3–5 天。若任务超过 5 天，应再次拆分。

### Phase 0：建立技能与产物底座

| ID | 原子改进项 | 主要落点 | 验收标准 | 依赖 | 规模 |
| --- | --- | --- | --- | --- | --- |
| P0-01 | 新增技能元数据 JSON Schema v1 | `backend/models/skill.py`、`docs/skill-schema.md` | schema 覆盖 name、description、version、category、requirements、third_party、risk、entrypoints；非法样例测试失败 | 无 | M |
| P0-02 | 用 YAML 解析器替换手写 front matter 解析 | `backend/api/skills.py`、依赖配置 | 正确解析 `>`/`|` 多行描述、数组和嵌套 third_party；原简易技能仍兼容 | P0-01 | S |
| P0-03 | 为技能生成稳定 `skill_id` 和内容摘要 | skill catalog service | 同一路径同内容 ID 稳定；内容变化产生新 digest；不暴露工作区外真实路径 | P0-02 | S |
| P0-04 | 对技能来源做去重与优先级决议 | skill catalog service | project > user > builtin；API 同时返回 shadowed 候选和生效来源 | P0-03 | M |
| P0-05 | 校验技能目录路径边界 | `workspace_security.py`、skill service | `cwd` 越界、symlink escape、工作区外 project skill 均返回 4xx | P0-02 | M |
| P0-06 | 新增技能详情 API | `GET /api/skills/{skill_id}` | 返回元数据、README 正文摘要、references、helpers、requirements、验证结果 | P0-03 | M |
| P0-07 | 给 Skills 列表 API 增加 workspace 参数贯通 | `SkillsPage.tsx`、客户端层 | 打开不同 workspace 时展示各自 `.pi/skills`，不再默认扫描后端进程 cwd | P0-05 | S |
| P0-08 | 合并 Skills 页面与 Settings 技能开关的数据源 | frontend skill store | 两个页面显示相同的启用状态、来源和错误；切换后无需刷新即可同步 | P0-06 | M |
| P0-09 | 新增技能详情抽屉 | `SkillsPage.tsx` | 可查看描述、依赖、许可、外部服务、文件清单和验证状态 | P0-06 | M |
| P0-10 | 新增技能静态验证命令 | `pi-science skills validate` | 可验证单个目录或全目录；错误带文件、字段和修复提示；退出码可靠 | P0-01 | M |
| P0-11 | 为运行时注入已启用技能清单快照 | `pi_manager.py`、session metadata | 每个新 session 记录 skill_id、digest、source、enabled_at；旧 session 可读取 | P0-03 | M |
| P0-12 | 记录技能实际触发事件 | session event normalizer | tool/event 流中记录 skill load、成功、失败、耗时；无 prompt 正文泄漏 | P0-11 | M |
| P0-13 | 定义统一 Artifact Manifest v1 | provenance models | 包含 path、kind、mime、producer、inputs、environment、verification、visibility | 无 | M |
| P0-14 | 将现有 provenance 记录映射到 Artifact Manifest | provenance service | 旧记录可无损读取；新记录同时具备版本、diff、环境与 manifest | P0-13 | L |
| P0-15 | 新增“发布产物”API | `/api/artifacts/publish` | 只能发布工作区内现存文件；返回稳定 artifact/version ID；重复发布幂等 | P0-14 | M |
| P0-16 | 新增产物回读校验状态 | provenance service/UI | 发布后校验 size/hash/mime；状态区分 pending/passed/failed，并可查看原因 | P0-15 | M |
| P0-17 | 在会话最终答复中渲染 Artifact Manifest 引用 | message renderer | 点击引用可打开 Inspector 对应版本；文件移动后仍按 artifact ID 定位 | P0-15 | M |
| P0-18 | 增加基础可观测性指标 | local history/API | 记录 skill trigger、artifact publish、verification、MCP call 的成功率和耗时 | P0-12、P0-16 | M |

**Phase 0 退出条件**：技能不再只是路径列表；任一会话都能回答“加载了哪个技能版本、调用了什么、产生了哪个可校验产物”。

### Phase 1：交付三个通用科研工作流与 MCP 治理

| ID | 原子改进项 | 主要落点 | 验收标准 | 依赖 | 规模 |
| --- | --- | --- | --- | --- | --- |
| P1-01 | 新增 bundled `literature-review` 技能骨架 | `skills/literature-review/SKILL.md` | 描述覆盖触发条件、检索、去重、证据分级、撤稿检查和失败模式；通过 validate | P0-10 | M |
| P1-02 | 定义 Citation v1 数据模型 | backend models | 支持 DOI/PMID/arXiv/URL、title、authors、year、retrieved_at、source、verification | 无 | M |
| P1-03 | 实现引用规范化与去重 | citation service | DOI 大小写、URL 变体、PMID 重复可合并；保留冲突字段 | P1-02 | M |
| P1-04 | 实现引用存在性验证接口 | citation service/API | 验证成功、未找到、网络失败、元数据冲突明确区分；带缓存和限速 | P1-03 | L |
| P1-05 | 在 Markdown/报告预览中显示引用验证徽标 | frontend | 用户能区分 verified/unverified/retracted-check-pending；不把未验证显示成通过 | P1-04 | M |
| P1-06 | 新增 bundled `pdf-explore` 技能 | skills + helper | 多页 PDF 一次抽取文本/页码索引；查询结果带页码；扫描失败有 OCR fallback 提示 | P0-10 | L |
| P1-07 | 为 PDF 建立持久页级索引 | backend service | 同一文件 hash 不重复解析；修改后自动失效；索引不越出 workspace | P1-06 | L |
| P1-08 | 新增 PDF 证据跳转 | PDF inspector | 技能输出中的页码引用可直接打开对应页 | P1-07 | M |
| P1-09 | 新增 bundled `figure-style` 技能 | skills + helper | 提供统一字体、DPI、配色、轴标签、图例和保存 API；附最小可运行示例 | P0-10 | M |
| P1-10 | 增加图像渲染后自动检查 | artifact verifier | 检查尺寸、DPI、空白图、裁切、透明背景、文件可读性；结果写入 manifest | P0-16、P1-09 | L |
| P1-11 | 增加 claim-data 一致性检查接口 | artifact verifier | 图标题/摘要中的方向性结论可绑定数据列与检查表达式；矛盾时 verification failed | P1-10 | L |
| P1-12 | 新增 bundled `figure-composer` 最小版本 | skills + frontend | 支持多面板布局、统一 panel label、组合后重新校验；首版不依赖子 Agent | P1-09、P1-10 | L |
| P1-13 | 定义 MCP Server/Tool Catalog 模型 | backend models | server 与 tool 分层；含 schema、auth、health、data_egress、license、tags | P0-01 | M |
| P1-14 | 从现有 MCP 配置构建只读 catalog | settings/MCP service | Settings 可展示每个 server 的工具数量和工具详情，不执行工具也能发现能力 | P1-13 | M |
| P1-15 | 新增 MCP 健康检查 | MCP service/API | 区分未安装、未授权、启动失败、协议失败、健康；超时不阻塞页面 | P1-14 | M |
| P1-16 | 新增数据外发确认元数据 | MCP UI | 工具调用前可展示发送到哪个服务、发送何类数据、条款链接；本地工具标记 no-egress | P1-13 | M |
| P1-17 | 支持技能声明所需 MCP 工具 | skill schema/runtime | 技能详情显示满足/缺失依赖；运行时缺失时给出可执行修复提示 | P1-13、P0-11 | M |
| P1-18 | 首批接入 4 个只读通用连接器 | MCP config/docs | 建议 Crossref、OpenAlex、PubMed、arXiv；均有健康测试、限速、条款和返回 schema fixture | P1-15、P1-16 | L |

**Phase 1 退出条件**：用户可以完成“检索真实文献 → 验证引用 → 深读 PDF → 生成并校验图表 → 发布带谱系报告”的端到端流程。

### Phase 2：计算、审查与可定制 Agent

| ID | 原子改进项 | 主要落点 | 验收标准 | 依赖 | 规模 |
| --- | --- | --- | --- | --- | --- |
| P2-01 | 定义 Compute Requirement v1 | backend models | 支持 cpu、memory、gpu、runtime、packages、timeout、network、secrets refs | P0-01 | M |
| P2-02 | 给技能增加能力匹配 API | skill/compute service | 返回 ready/degraded/blocked 及逐项原因；不通过运行代码探测危险能力 | P2-01 | M |
| P2-03 | 建立不可变 Environment Snapshot v2 | provenance/kernel | 同时记录 Python/R/Node、OS、包 lock hash、容器/conda 信息和技能 digest | P0-11、P2-01 | L |
| P2-04 | 定义 provider-neutral Job Contract | run models/API | submit/status/cancel/logs/artifacts 五个接口；本地 provider 可完整实现 | P2-01 | L |
| P2-05 | 将现有实验 Runs 迁移到 Job Contract | runs service | 老 runs 可读取；新本地任务支持取消、超时、产物关联和环境快照 | P2-04 | L |
| P2-06 | 新增 SSH/Slurm provider 插件接口 | compute providers | 使用 fake provider 完成 contract test；凭据只存引用不写日志 | P2-04 | L |
| P2-07 | 定义 Managed Model Endpoint v1 | endpoint models | 支持 local/remote、health、schema、rate limit、secret ref、data egress | P1-13、P2-04 | M |
| P2-08 | 新增模型端点注册与试调用页面 | Settings | 可注册、测试、禁用；响应样例可脱敏保存；失败不污染主模型配置 | P2-07 | L |
| P2-09 | 定义 Agent Profile v1 | backend models | 包含 identity、skills、connectors、excluded_tools、thinking、read/write scope | P0-01、P1-13 | M |
| P2-10 | 新增 Agent Profiles 只读目录页 | frontend/API | 展示默认与扩展 Agent 的能力和权限；未知字段安全降级 | P2-09 | M |
| P2-11 | 新增 profile 创建与编辑工作流 | frontend/API | 创建前预览权限；保存后回读确认；删除和扩大权限需显式确认 | P2-10 | L |
| P2-12 | 实现独立只读 Result Reviewer | reviewer service | 只读取 transcript、logs、artifacts；能发现“声称执行但无记录”和“产物数值与日志矛盾” | P0-14、P2-04 | L |
| P2-13 | 增加 Citation Reviewer 规则 | reviewer service | 具体 DOI/PMID/arXiv ID 无来源或验证失败时产生结构化 finding | P1-04、P2-12 | M |
| P2-14 | 增加 Artifact Reviewer 规则 | reviewer service | 标题/结论与绑定数据检查失败时阻止标记 verified；不修改原文件 | P1-11、P2-12 | M |
| P2-15 | 新增 transcript bookmarker | session service/UI | 自动选取 0–2 个已落地结论或产物链接；只保存可锚定原文 span | P2-12 | M |
| P2-16 | 将项目知识 Reviewer 与结果 Reviewer 分开展示 | Knowledge/Session UI | 用户能区分“建议写入项目知识”和“发现结果可信度问题”，状态互不覆盖 | P2-12 | M |

**Phase 2 退出条件**：技能能声明并匹配计算资源；任务可以迁移到统一 job 模型；Agent 权限透明；最终结果可由独立只读 Reviewer 审查。

### Phase 3：技能工程、质量门禁与规模化扩展

| ID | 原子改进项 | 主要落点 | 验收标准 | 依赖 | 规模 |
| --- | --- | --- | --- | --- | --- |
| P3-01 | 新增 `skills init` 脚手架 | CLI | 生成 SKILL.md、tests、references、helpers、LICENSE metadata；默认可通过 validate | P0-10 | M |
| P3-02 | 新增技能 fixture 测试格式 | skill test framework | 每个 case 含 user prompt、expected trigger、forbidden trigger、required outputs | P0-12 | M |
| P3-03 | 实现触发准确率离线评测 | eval CLI | 输出 precision、recall、误触发样例；固定 seed；结果可保存为 artifact | P3-02 | L |
| P3-04 | 实现技能工作流回归测试 | eval runner | 可使用 mock MCP/kernel 跑 happy path、dependency missing、tool failure、invalid output | P3-02 | L |
| P3-05 | 增加技能质量等级 | catalog service/UI | draft/validated/verified/deprecated；升级必须满足对应门禁 | P3-03、P3-04 | M |
| P3-06 | 建立第三方许可与条款扫描 | CI/validator | 外部模型、服务、数据源缺许可或隐私元数据时 warning/error 可配置 | P0-01 | M |
| P3-07 | 建立 prompt injection fixture 集 | security tests | 覆盖 PDF、网页、MCP 返回、项目文件中的恶意指令；不得越权执行 | P1-06、P1-14 | L |
| P3-08 | 建立敏感数据外发策略 | workspace policy | 可按项目禁止外部服务或限定域名/数据类型；调用前后都有审计记录 | P1-16 | L |
| P3-09 | 增加技能版本迁移与弃用提示 | catalog/runtime | session 固定旧 digest 可复现；新 session 提示升级；删除不会破坏历史 | P0-11、P3-05 | M |
| P3-10 | 拆分大型前端 viewer vendor chunk | Vite config/routes | 首屏不加载 3Dmol、OpenChemLib、ExcelJS；构建产物中按 viewer 动态分包 | 无 | M |
| P3-11 | 增加前端 bundle budget | CI | 核心入口与单个异步 chunk 超阈值时 CI 失败；第三方例外有显式白名单 | P3-10 | S |
| P3-12 | 选择一个垂直领域做 3 技能试点 | product/skills | 建议先选材料、组学或计算化学之一；3 个技能全部达到 verified，暂不追求目录数量 | P3-05、P2-02 | L |

**Phase 3 退出条件**：新增技能有脚手架、测试、评测、许可审查、版本策略和 CI 门禁，平台可以安全扩充领域目录。

## 4. 推荐的首个 MVP 切片

首个可发布切片建议限定为 18 个原子任务：

1. P0-01～P0-12：完成技能 schema、可靠发现、workspace 贯通、详情 UI、运行快照和触发记录。
2. P0-13～P0-17：完成统一产物 manifest、发布、回读验证和会话引用。
3. P1-01：加入 literature-review 技能骨架。

该切片完成后，Pi-Science 会首次形成可演示闭环：用户在某个 workspace 发起文献研究，系统明确加载哪个技能版本，生成报告文件，发布为带环境与来源的 artifact，并能从最终答复直接回到对应版本。引用在线验证、PDF 深读和图表 QA 放在紧随其后的 MVP+1，避免首个切片同时引入太多外部网络不确定性。

## 5. 明确不做的事项

1. 不直接复制全部 29 个技能。先证明 3 个通用技能和 1 个垂直领域的质量门禁有效。
2. 不直接 vendor 全部 87 个 bio-tools 模块。先用 server/tool catalog 管理现有 MCP，再接入 4 个高复用只读连接器。
3. 不把项目知识 Reviewer 扩写成万能 Reviewer。知识提取与结果事实审查应保持独立 prompt、权限和状态。
4. 不在技能 YAML 中保存 API key、SSH 私钥或明文 endpoint secret，只保存 credential reference。
5. 不把“技能安装成功”视作“技能可用”。必须同时通过依赖匹配、健康检查和至少一个 fixture。
6. 不允许技能绕过现有 workspace security、文件审批和 provenance 记录。
7. 不因参考仓库为 Apache-2.0 就忽略其内部第三方模型、权重、API、数据服务各自的许可和数据外发条款。

## 6. 里程碑与量化指标

| 里程碑 | 目标 | 建议指标 |
| --- | --- | --- |
| M0：可信技能目录 | 技能可发现、可解释、可验证 | 100% bundled skills 通过 schema；workspace 识别错误为 0；目录 API p95 < 300 ms |
| M1：科研交付闭环 | 文献/PDF/图表产物可发布和回读 | artifact 发布成功率 > 99%；引用对象 100% 带验证状态；图像空白/损坏拦截率 100% |
| M2：可移植执行 | 环境与任务可复现 | 100% job 关联 environment snapshot；取消/超时 contract tests 全通过 |
| M3：独立质量审查 | 审查声明、引用和产物 | 基准集中高严重度矛盾召回率 ≥ 90%；无证据时误报率 ≤ 5% |
| M4：技能规模化 | 新技能可持续进入目录 | verified 技能必须有触发评测、工作流 fixture、许可元数据和安全 fixture |

## 7. 每个原子 PR 的统一验收模板

```text
目标：本 PR 只改变一个主要行为。
输入：明确列出 API、文件、事件或用户操作。
输出：明确列出新增/变化的数据结构和 UI 状态。
兼容：说明旧 session、旧 provenance、旧技能是否可读取。
安全：说明 workspace、secret、data egress、删除/覆盖边界。
测试：至少一个成功、一个失败、一个边界用例。
观测：说明成功率、耗时或失败原因记录在哪里。
回滚：说明关闭 feature flag 或回退数据读取的方法。
```

## 8. 当前验证基线

本方案生成时的本地验证结果：

- 后端：`167 passed, 21 skipped`。
- 前端：`9` 个测试文件、`49 passed`。
- 前端生产构建：通过。
- 已知非阻塞告警：3Dmol 依赖包含 direct `eval` 警告；多个科学 viewer/vendor chunk 超过 500 kB，已拆为 P3-10/P3-11 独立治理。

## 9. 下一步执行入口

建议直接从 **P0-01 → P0-02 → P0-05 → P0-06 → P0-07** 开始。这五项能最早消除当前技能目录的结构性限制，并为后续所有技能、MCP、计算与 Reviewer 工作提供稳定契约。完成后再并行推进 P0-10（validator）与 P0-13（Artifact Manifest）。

## 10. 本轮实施结果

本方案已在当前工作区完成第一轮可运行实现，原“下一步执行入口”已转化为代码和 API：

- P0 技能底座：YAML front matter、Pydantic metadata contract、来源优先级、workspace 详情/验证 API、CLI `skills validate/init/eval`、技能 digest/quality、Settings/Skills workspace 贯通。
- P0 运行与产物：session skill snapshot、skill events、Artifact Manifest、幂等发布、哈希/MIME/文件回读验证、SSE `artifact.published` 和可点击会话产物状态。
- P1 科研工作流：`literature-review`、`pdf-explore`、`figure-style`、`figure-composer` 技能包；Crossref/OpenAlex/PubMed/arXiv 归一化检索；DOI/PMID/arXiv/URL 引用规范化与验证；PDF hash 页面索引；图像/claim-data 验证。
- P1 MCP：server/tool catalog、stdio/HTTP health、auth 状态、数据外发说明、terms/privacy 元数据和项目 egress policy；Settings MCP 页已改为动态 catalog。
- P2 执行与 Agent：Compute Requirement、本地 Job Contract（submit/status/cancel/logs/timeout）、Fake provider contract fixture、模型端点注册/健康检查/开关、Agent Profile 目录与 CRUD、只读 Result Reviewer、transcript bookmarker。
- P3 质量门禁：fixture 触发 precision/recall 评测、workflow output fixture、第三方 metadata warning、外部内容 prompt-injection 检查、前端重 viewer 动态分包和 `npm run test:bundle` budget。
- 垂直切片：材料相图、分子结构 QC、固体能带分析三个可验证技能包，作为后续领域扩展的最小样板。

最终验证结果：后端 `206 passed, 22 skipped`；前端 `49 passed`；生产构建通过；`ruff check`、Python compileall、全目录 `skills validate --strict`、全部 skill fixtures、15 条核心 OpenAPI 路由检查均通过。构建仍会报告第三方 3Dmol 的 direct `eval` 和大体积 vendor chunk 警告；重型 viewer 已移出入口 chunk，预算脚本只约束非 vendor 入口。
