. Here's the comprehensive report.

---

# 勘察报告：会话导航 / 书签 / 阅读位置 现状（方案 4.2 实现准备）

**工作树**：`/Users/cyq/deepseek`（git worktree，分支 `feat/reverse-cs-inspiration`）
**基准**：分支上最新提交为 `0af0c5b fix(conversations): make bookmark suggestions actionable`，紧接其核心特性提交 `d0c55de feat(conversations): add durable bookmarks and reading attention`。方案 4.2 的大部分**已经实现**，本报告聚焦剩余差距。

---

## 1. 已实现能力清单

### 书签（Bookmarks）—— 基本完整
- **服务端模型**：`ConversationNavigationRepository`（`apps/server/src/conversation-navigation/repository.ts`），完整 CRUD。
  - 字段：`bookmark_id`(UUID/legacy hash)、`session_id`、`message_id`、`role`(user/assistant)、`quote`(≤500，Node 从 session JSONL 解析，不信任客户端文本)、`label`(≤160，可空)、`origin`(`user`/`agent_proposal`/`legacy_auto`)、`status`(`accepted`/`proposed`/`rejected`)、`created_at`、`updated_at`。
  - 幂等：同 (session, message) 复用；rejected 书签可被用户操作复活为 accepted。
  - 每 session 上限 500 条。
  - 存在**自动 bookmark 提案**机制：`proposeBookmarks(cwd, sessionId, messageIds)` + 路由层启发式 `proposeCandidates()`（中英文关键词，英文 `\b...\b` 全词匹配，CJK 子串匹配，确定性取最后 2 条）。提案 `origin="agent_proposal", status="proposed"`，**绝不自动接受**。
  - 兼容旧 `.pi-science/bookmarks.jsonl` 只读折叠（schema v1 JSON 存储 + 墓碑 `legacy_deleted_ids`）。
  - 删除：`proposed+agent_proposal` 删除转为 durable `rejected`（抑制再次提案）；accepted 直接删除。
- **API**：`GET/POST /api/bookmarks`、`POST /api/bookmarks/propose`、`PATCH/DELETE /api/bookmarks/:bookmark_id。
- **前端 UI**：`ConversationBookmarksPanel`（列表/接受/拒绝/删除/建议/计数）、`MessageActions` 消息内书签 toggle、`ConversationNavRail` 书签圆点标记、header 书签计数徽章。
- **测试**：services + routes + frontend + contracts 均有覆盖（见 §6）。

### 阅读位置（Read State）—— 基本完整
- **服务端**：`readState` / `updateReadState`，字段 `anchor_message_id`(可空)、`at_bottom`、`seen_snapshot_version`、`updated_at`。
  - `at_bottom=true + mark_seen=true` 时由 Node 记录**当前 snapshot version**（文件 size:mtime，绝不信客户端）；`at_bottom=false` 只移动 anchor，不清 seen（滚动历史不清 "New"）。
  - anchor 经 `messageLocator` 校验属于该 session，否则 `invalid_anchor`(422)。
- **API**：`GET/PUT /api/sessions/:session_id/read-state`。GET 附加动态 `before` 游标 + `anchor_available`（不持久化陈旧 opaque 游标）。
- **前端**：`useConversationNavigation` 的 `scheduleAnchorWrite`(400ms) / `scheduleMarkSeen`(300ms) 分离防抖 + 去重 + 会话切换取消；`LiveSessionPage` 在**进入会话时恢复上次阅读位置**（`restore` 逻辑：读 state → 若 `at_bottom` 保持底部；若 `anchor_available && before` 则 `loadOlderForTarget` 分页加载目标页后 `scrollToLoadedTarget`；4s safety net 释放写抑制）。`ConversationNavRail` `onActiveChange` 上报视口顶端 user message。
- **测试**：repository、routes、hook、LiveSessionPage 均有覆盖。

### Attention Queue —— 部分实现（状态集合≠方案 4.2）
- **服务端**：`GET /api/attention` 聚合每个 session 状态：`needs_you`（`hasPendingInteraction`，即 `question.asked`/`permission.asked`）→ `running`（`nodeSessionService.busySessionIds`）→ `unread`（readState 的 `seen_snapshot_version` ≠ 最新 snapshot 且最新可见消息为 assistant）→ `idle`。优先级排序 + `limit`(≤100) 截断 + `counts`。
- **前端**：`useConversationAttention`（15s stale），`ProjectsLayout` 侧边栏会话列表徽章（Needs you / Running / New）+ 头部聚合计数。
- 状态枚举仅 `needs_you | running | unread | idle`（contracts + client types + 服务端一致）。

---

## 2. 数据模型与存储

- **单一规范文件**：`.pi-science/conversation-navigation.json`（schema v1），由 `ConversationNavigationRepository` 管理。
- **持久化契约**（repository.ts 头部注释）：
  - 不存绝对路径、不存 opaque 持久游标（每次读从 session 文件重解析 `before`）、不存 transcript 全文（仅书签 capped quote）。
  - 所有写入走共享 `withFileWriteLock` + `writeJsonAtomic` 原语（`.pi-science` 目录由 `workspaceFile` 解析）。
- **V1 结构**：`{ schema_version:1, bookmarks:[], read_states:{sessionId:...}, legacy_deleted_ids:[] }`。`legacy_deleted_ids` 为增量字段，旧 v1 文件无此字段读为空。
- **旧数据迁移**：`.pi-science/bookmarks.jsonl`（legacy）只读折叠为 `proposed` 书签，首个写入时物化进 JSON；legacy 文件永不重写（回滚安全），删除用墓碑 id 抑制再导入。
- **顶层辅助**：`apps/server/src/app/server-modules.ts` 构建 `ConversationNavigationRepository`，注入 `SessionRepository`；`apps/server/src/app/app.ts` 在第 123/126 行注册路由。
- **清理**：session 删除时 `cleanupSession` best-effort（`node-session-routes.ts` 第 207-211 行）。

**数据模型与方案 4.2 的差距**：目前书签锚定粒度为 **session + message_id**（每条消息取整条可见文本的前 500 字符作 quote）。方案 4.2 要求的"锚定 **message ID / block / 原文 span**"——**span（块内偏移）未实现**；`block` 概念在前端 thread model 中存在（`ThreadBlock`），但服务端导航层只认 session→message 两元。`quote` 是整段截断快照，无 span [start,end] 或块索引字段。

---

## 3. 现有 API 端点清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bookmarks?cwd&session_id` | 列书签（session 可选过滤）；404 未知 session |
| POST | `/api/bookmarks?cwd&session_id` | 有 `message_id` body→创建用户书签；无 body（兼容）→启发式提案 |
| POST | `/api/bookmarks/propose?cwd&session_id` | 启发式生成提案（`proposeCandidates`） |
| PATCH | `/api/bookmarks/:bookmark_id?cwd` | 更新 status（`accepted`/`rejected`） |
| DELETE | `/api/bookmarks/:bookmark_id?cwd` | 删除（proposal→durable reject） |
| GET | `/api/sessions/:session_id/read-state?cwd` | 读阅读状态 + 动态 before/anchor_available |
| PUT | `/api/sessions/:session_id/read-state?cwd` | 更新阅读状态 |
| GET | `/api/attention?cwd&limit` | Attention Queue 聚合 |

另有辅助业务端点（非导航专用但被导航使用）：会话全部消息索引（`roles=all`）服务端方法 `messageIndex`以及前端 `getMessagesPage`（`loadMessagesForNavigation` 依赖）——这些走既有 session REST。

**前端 client** `frontend/src/lib/conversation-navigation/api.ts`（7 个方法），type 镜像 contracts：`frontend/src/lib/conversation-navigation/types.ts`。

---

## 4. 与方案 4.2 的差距（缺失点）

| 方案 4.2 需求 | 现状 | 缺口 |
|---|---|---|
| 用户手工书签 | ✅ 完整 | — |
| 自动 bookmark **提案**（agent 提案、用户接受） | ✅ 已有（`agent_proposal` + `propose` 启发式 + 接受/拒绝 UI） | 启发式是**纯本地关键词**；无 Pi agent 主动调 `/propose` 或提交候选的运行时集成（对照 ledger 的 proposal→accepted 语义，navigation  proposal 审批门，但 `approveBookmark` 已是 acceptance 语义）。可作为扩展 |
| 书签锚定 **message ID** | ✅ 有 (`message_id`) | — |
| 书签锚定 **block** | ⚠️ 服务端无 block 概念；前端 `ThreadBlock` 有 kind/id | 服务端导航层不感知块 |
| 书签锚定 **原文 span** | ❌ 无 | quote 为整段前 500 字符，无 span [start/end]/块索引 |
| 恢复上次阅读位置 | ✅ 完整
