# Artifact 系统勘察报告（为方案 4.1 实现准备）

> 勘察人：Pi-Science 勘察代理
> 日期：2026-08，分支 feat/reverse-cs-inspiration
> 性质：只读勘察，未修改任何源码。
> 依据：CLAUDE.md、docs/reverse-cs-inspiration.md（第 4.1/6.1/14.2 节）、docs/adr-conversation-navigation-artifact-lineage.md 及下述代码。

---

## 1. 现状数据模型

### 1.1 Canonical 存储
- 位置：每个工作区根下 `.pi-science/`（= metadataRoot(workspace)，见 apps/server/src/storage/persistence.ts:19 与 :200 的 workspaceFile）。不是 .pi/，是 .pi-science/。
- 格式：JSONL（每行一个 JSON 对象），追加写 + 行级 lock（withFileWriteLock），非规整 JSON、无 SQLite。
- 关键文件：
  - artifacts.jsonl —— manifest 权威源（本报告核心）。
  - provenance.jsonl —— 版本历史 / 产生记录。
  - turn-artifacts.jsonl —— 对话每 turn 产物摘要（前端恢复卡片用）。
  - .pi-science/env/<hash>.txt —— 环境锁文件快照。
- 无索引文件（SQLite/graph 索引明确列为非目标）。

### 1.2 Manifest v2 字段与版本
核心类型：packages/contracts/src/index.ts:150-198（artifactManifestSchema / artifactVersionRefSchema / artifactClassificationSchema / artifactManifestV2Schema / artifactLineageResponseSchema），服务端归一化在 apps/server/src/runtime/artifacts/artifact-manifest.ts。

ArtifactManifestV2 关键字段：
- schema_version：2（加性版本；v1 行在内存中按 v2 解释，文件不重写）
- artifact_id：string(24 hex)，见 1.3 身份派生
- version：int>0，每 artifact 单调递增
- path：工作区相对路径（清洗反斜杠）
- kind / mime / size / sha256：渲染与校验元数据
- published_at：ISO 发布时刻
- inputs：Array<{artifact_id,version} | string>（max 100），版本化输入引用 + 旧式字符串输入
- supersedes：{artifact_id,version} | null，取代的旧版本
- classification：intermediate | deliverable | unspecified，产物分类
- producer：object（tool / session_id / model / run_id）
- environment：object，环境快照
- verification：object（status / checks / checked_at）

### 1.3 身份如何派生（关键，与方案 4.1 的‘稳定逻辑身份’直接相关）
artifact_id = sha256(cwd + ':' + relativePath) 取前 24 hex。两处重复实现：
- 显式 publish：apps/server/src/http/routes/artifact-routes.ts:31。
- 自动 write/edit 探测：apps/server/src/runtime/events/node-event-observer.ts:82（用 workspace 绝对路径，非 cwd，但语义一致）。

耦合结论：artifact_id 与文件路径强耦合。文件重命名/移动/换工作区路径 → 重新派生 → 新 artifact_id，历史版本链断裂。这正是 reverse-cs 文档 §4.1 指出的缺陷。

旧式 v1（无 schema_version）行在内存中归一化为 classification:'unspecified'、空版本化 inputs；字符串 inputs 保留为 unresolved_inputs，不构成 DAG 边（artifact-manifest.ts:35-67）。重复 artifact_id+version 行以最后一条为准（collapse 机制，:75-82）。

### 1.4 已实现的关系（v2）
- consumes（inputs 中版本化 ref → 上游）
- supersedes / superseded_by
- consumed_by（下游）
- 校验 validateVersionedRelations（artifact-manifest.ts:146-184）：missing/duplicate/self-version/cross-workspace/超 100 条 → 422；允许 supersede 同 artifact 旧版本。

### 1.5 对话内产物（turn artifacts）
- 存储：.pi-science/turn-artifacts.jsonl，模型 TurnArtifactRecord / TurnArtifactItem（apps/server/src/runtime/artifacts/turn-artifact-repository.ts）。TurnArtifactItem 含 artifactId? / version?（可选，Weak 关联）。turn_ordinal 跨 runtime 重启稳定。
- 前端从 SSE 事件 attachTurnArtifacts + 历史恢复 attachPersistedTurnArtifacts（frontend/src/lib/agent-runtime/turn-artifacts.ts）填充 TurnArtifactSummaryBlock。

---

## 2. 现有 API 端点清单

**Artifact（artifact-routes.ts，全部 node-control-plane，需 cwd query）**
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | /api/artifacts | 列 manifest（可选 artifact_id / path / limit / latest=1），倒序 |
| POST | /api/artifacts/publish | 显式发布，默认 deliverable，校验关系并写 JSONL + provenance |
| GET | /api/artifacts/:artifact_id | 取单条（可 ?version=） |
| GET | /api/artifacts/:artifact_id/lineage | 返回 upstream/downstream/unresolved_inputs（可 ?version=） |
| POST | /api/artifacts/verify | sha256 校验并追加 verification 行 |
| POST | /api/artifacts/claim-check | 断言检查（非核心） |
| GET | /api/provenance | 列 provenance 记录（path/session_id/limit） |
| GET | /api/provenance/versions/* | 单文件版本历史 |
| POST | /api/provenance/record | 手写 provenance |
| POST | /api/provenance/capture | 环境快照 |
| GET | /api/provenance/env/:hash | 读环境锁文件 |

**Turn artifacts（turn-artifact-routes.ts）**
| GET | /api/sessions/:session_id/artifacts | 某会话的 turn 产物列表（{ turns }） |

**自动写入口（非路由）**：node-event-observer.ts 的 observeWrittenArtifact 侦听 write/edit 事件 → 写 intermediate manifest + provenance + 发 artifact.published SSE。

---

## 3. 前端展示链路：数据流 API → UI

- 文件预览路径：FilesPage / thread artifact card → fileInspectorForPath（frontend/src/lib/artifacts/artifacts.ts:193）→ RightPane 打开 FilePreviewInspector（FilePreviewInspector.tsx）。History 按钮 → lazy 加载 ProvenancePanel → 内嵌 lazy ArtifactLineagePanel。
- Lineage client：frontend/src/lib/artifacts/artifact-lineage.ts。
  - getArtifactLineage：先 GET /api/artifacts?latest=1（按 path 取最新 manifest，或 GET /api/artifacts/:id?version=），再 GET /api/artifacts/:id/lineage?version=。
  - useArtifactLineage：React Query；queryKey 含 fileRevision 信号，turn 落盘带文件变更时自动 refetch。
  - 404 → not-found（不重试）；5xx/网络错误 → 抛出重试。
- ArtifactLineagePanel（ArtifactLineagePanel.tsx）：无 manifest / 错误时渲染空；展示分类徽章 + 确切版本 chip + 分组关系（inputs/supersedes、dependents、unresolved）；点击‘以确切版本打开’另一文件（artifactVersion 透传）。
- ProvenancePanel（ProvenancePanel.tsx）：在 lineage 面板之下列出该文件所有 provenance 版本，支持展开查看 code/diff/run、锁文件、reproduce 起草、跳回会话。
- 版本目标跳转：FilePreviewInspector 的 artifactVersion prop → 默认打开 History、提示‘正在看确切版本’。
- 会话产物条：TurnArtifactStrip.tsx 渲染每 turn 生成文件卡片（Claude Science 风格），点击 → inspector。当前不带 manifest 关联（artifactId/version 可选但 strip 未使用）。

注意：当前没有项目级 Artifact Library 页面、无 manifest 列表页面、无版本比较/依赖视图。

---

## 4. 与方案 4.1 的差距

### 4.1 规划目标（reverse-cs §4.1 + §14.2 + §6.1）
1. 逻辑 artifact 与不可变版本分离（可移动路径的身份）
2. 稳定逻辑身份，独立于路径
3. 5 类关系：derived_from / supersedes / consumes / produced_by / reviewed_by
4. Inspector 展示输入版本、producing 代码/run/环境、下游消费、是否被取代、中间/正式分类
5. 项目级 Artifact Library 页面（非每轮对话卡片）

### 4.2 已有（可复用）
| 规划项 | 现状 |
|---|---|
| 不可变版本 | ✅ artifact_id + version，加性 v2，last-write-wins |
| supersedes / 取代链 | ✅ v2 supersedes（上游）+ superseded_by（下游） |
| consumes / 消费关系 | ✅ inputs 版本化 ref（上游），consumed_by（下游） |
| produced_by | ✅ producer(tool/session_id/model/run_id)；provenance 也带 sessionId |
| 中间/正式分类 | ✅ classification（显式 publish 默认 deliverable；自动探测默认 intermediate） |
| Inspector 输入/下游/取代/分类展示 | ✅ lineage 面板（确切版本 chip、分组、可点击） |
| producing 环境 | ✅ environment + env/<hash>.txt 锁文件 |
| 环境不重跑 / reproduce | ✅ provenance 记录 code/run，reproduce 起草 |

### 4.3 缺失（需实现）
1. 稳定、独立于路径的逻辑身份 —— 最核心缺口。
2. derived_from 关系（语义/血缘，区别于机械的 consumes inputs）。
3. reviewed_by 关系（与 review 状态关联）—— 目前 review 只是 inspector 的 reviewPassed UI 标志，无持久关系字段。
4. Artifact Library 页面（项目级浏览/版本比较/聚合 DAG）。
5. provenance 的 artifact 链接字段不全：recordProvenance 只存 path/version/sha256；appendProvenance(observer) 已存 artifactId/artifactVersion/artifactHash。两条写路径结构不一致。
6. 前端 manifest 列表客户端缺失（无 listArtifacts 等价物）。

---

## 5. 实现建议

### 5.1 身份解耦（最高优先、最需谨慎）
- 目标：引入独立于路径的稳定逻辑身份（logical_id / 持久 UUID），manifest 增字段，同时保留 artifact_id（路径哈希）向后兼容。
- 建议做法（保持文件为 canonical，不回填迁移）：
  1. manifest v3 或 v2 内加性字段 logical_id?: string；首次发布/被观察写入若无则生成随机 UUID 存盘（写时惰性绑定）；artifact_id 保留历史值。
  2. publish 解析：优先按 logical_id 匹配既有链累积 version；无则 fallback 路径 hash。
  3. 改名/移动：新增 PUT rename/retarget 端点，更新 manifest 的 path 并保留 logical_id（写新行，last-write-wins 覆盖旧 path）。
- 兼容性风险：
  - 两处身份派生（route + observer）必须同步改，否则同一文件两条链并存。
  - provenance.jsonl 两条写路径结构不一致（route 无 artifactId，observer 有），统一时注意。
  - lineage ref 目前按 {artifact_id,version}；引入 logical_id 后需决定 ref 字段语义，避免双主键混乱。建议 ref 仍用 artifact_id 作为历史主键，logical_id 仅作聚合/迁移键。
  - 旧会话、旧 artifact、旧 publish 流程的回滚安全（reverse-cs §14 已声明附加字段式回滚）。

### 5.2 新增关系字段
- derived_from：建议复用 inputs 的版本化 ref + 新增 derived_from: Array<ArtifactVersionRef>，或定义 relations 子对象，避免 v2 schema 破坏性。
- reviewed_by：新增 reviews / reviewed_by: Array<{review_id, actor, status, at}>；与 ArtifactInspector 的 reviewPassed 打通（需新持久化端点，参考 review-status.test.tsx 现有 review UI）。

### 5.3 Artifact Library 页面（新增文件）
- 路由：frontend/src/app/router.tsx 增加 workspace/:cwd/artifacts（仿 FilesPage / KnowledgePage）。
- Server：扩展 GET /api/artifacts 或在 artifact-routes.ts 增加聚合端点（filter by classification / superseded / producer），返回按 artifact_id 归类 + 版本列表 + 关系摘要。
- 前端新 lib：frontend/src/lib/artifacts/artifact-library.ts（复用 apiRequest，仿 artifact-lineage.ts）。
- 组件：frontend/src/components/artifacts/ArtifactLibrary 等；瀑布列表 + 版本比较 + lineage 概览。

### 5.4 Inspector / strip 增强
- ArtifactLineagePanel：加入 derived_from / reviewed_by 分组；‘被更新版本取代’高亮。
- TurnArtifactStrip：卡片带 artifactId/version 徽章并接 lineage 打开（item.artifactId/version 已存在但未展示）。

### 5.5 建议改动/新增文件清单
改动：artifact-manifest.ts、artifact-routes.ts、node-event-observer.ts、packages/contracts/src/index.ts、turn-artifact-repository.ts、frontend/src/lib/artifacts/artifact-lineage.ts、types/thread.ts、ArtifactLineagePanel.tsx、TurnArtifactStrip.tsx、frontend/src/app/router.tsx。
新增：ArtifactLibrary.tsx（+子组件）、artifact-library.ts、可能的 artifact-library-routes.ts、对应测试。

### 5.6 风险点
1. 身份迁移兼容性（最高）：双 id 映射、两处派生同步、ref 语义、旧数据不迁移。
2. provenance 结构不一致：route 与 observer 两条写路径字段不同。
3. v2 ref 主键：插入字段不能破坏既有 {artifact_id,version} ref 校验（validateVersionedRelations）。
4. local-first 约束（reverse-cs §6.1）：索引不得成为第二状态权威；文件保持 canonical。
5. 范围：reverse-cs 规划本身把 Artifact Library 列为 Medium（非 Quick win）；当前批次（§14.2）只实现最小 lineage。完整 DAG/Library 是放大范围，需按可回滚、可独立 review 分批（CLAUDE.md 重构规则）。

---

## 6. 相关测试清单

服务端：
- apps/server/src/http/routes/artifact-routes.test.ts（发布/关系/lineage/422 校验）
- apps/server/src/runtime/artifacts/artifact-manifest.test.ts（归一化/collapse/校验/buildLineage/跨工作区）
- apps/server/src/runtime/artifacts/turn-artifact-repository.test.ts（turn 持久化/ordinal）
- apps/server/src/http/routes/turn-artifact-routes.test.ts
- apps/server/src/runtime/artifacts/workspace-artifact-snapshot.test.ts（快照 diff）
- apps/server/src/runtime/node/node-session-service.test.ts、apps/server/src/runtime/events/node-event-observer.test.ts（自动 write/edit 探测）

前端：
- frontend/src/components/inspector/ArtifactLineagePanel.test.tsx（lineage UI）
- frontend/src/components/inspector/FilePreviewInspector.test.tsx、InspectorTabs.test.tsx、RightPane.test.tsx
- frontend/src/lib/artifacts/artifact-autopreview.test.ts、artifacts.test.ts
- frontend/src/lib/agent-runtime/event-fold.turn-artifacts.test.ts、frontend/src/lib/conversation/turn-artifact-snippet.test.ts
- frontend/src/app/routes/FilesPage.test.tsx / KnowledgePage / RunsPage（Library 可仿照）
- UAT：pnpm --filter frontend test:uat:conversation

验证入口：pnpm typecheck、pnpm test、pnpm build、pnpm smoke（见 CLAUDE.md）。

---

## 附：本次勘察读取的关键源码位置
- 数据模型/身份/关系：apps/server/src/runtime/artifacts/artifact-manifest.ts
- 路由/发布/lineage/provenance：apps/server/src/http/routes/artifact-routes.ts
- 自动写探测：apps/server/src/runtime/events/node-event-observer.ts
- 对话产物持久化：apps/server/src/runtime/artifacts/turn-artifact-repository.ts
- DTO schema：packages/contracts/src/index.ts:150-205
- 前端 lineage client：frontend/src/lib/artifacts/artifact-lineage.ts
- Inspector：ArtifactLineagePanel.tsx / ProvenancePanel.tsx / FilePreviewInspector.tsx / ArtifactInspector.tsx
- 会话产物条：frontend/src/components/conversation/TurnArtifactStrip.tsx
- 存储/锁：apps/server/src/storage/persistence.ts