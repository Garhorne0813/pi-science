# PR #112 阶段 A：集成与协议核对记录

日期：2026-10-08。范围：PRD 第 9 节阶段 A；阶段 B/C/D 尚未实施。

## 基线与同步方式

- GitHub 当前 main 与本地 HEAD 一致：`410e8daf601f330b8ce5f6c29ac0604858cd767c`。
- PR #112 head：`9da3d5121a3eac428c53025367d3df3cdc484c44`。
- Git fetch 失败：无法连接环境代理 proxy:8080。改用已授权的 GitHub 接口读取 main 和 PR 的全部 25 个文件补丁，在当前 main 工作树集成。
- 先基于最新 main 完成本地补丁集成，再按用户要求通过 GitHub Git Data API 发布到 PR 分支。发布提交使用 PR head 作为第一父提交、上述 main 作为第二父提交，并对旧 PR head 校验 expected_sha，保留两侧历史且无需 force push。未合并 PR。

## 冲突处理

| 文件 | 冲突与处理 |
| --- | --- |
| frontend/src/lib/client/sse-transport.ts | PR hunk 以旧事件数组为上下文，main 已使用共享 conversationEventTypes。仅加入 visibility 暂停/恢复字段和回调，保留共享列表、正式事件处理、applied cursor、gap fence 与主分支其他逻辑。 |
| frontend/src/components/conversation/ConversationBlocks.tsx | main 已有 turn.startedAt/endedAt。给 live status 传入 turn.startedAt ?? turn.user?.timestamp，保留现有结束时间和主分支的 operation 时间语义。 |
| frontend/src/lib/agent-runtime/listener.ts | 文本应用成功。保留 main 的 operation.started/operation.settled 运行状态处理，叠加 PR 的 runs signal。其旧事件边界是 R-03，按 PRD 留给阶段 B，不能视为语义迁移已完成。 |
| packages/contracts/src/conversation-events.ts | PR 未修改此文件；保留 main 的正式共享名单。 |
| .github/workflows/quality.yml | 将 Linux SSE budget 门禁放在全项目 build / bundle budget 后，保留 main 的 Node 24.16.0 与 Windows 串行测试配置。 |
| frontend/src/lib/client/sse-transport.test.ts | 新引入的 applied-cursor 测试使用旧 text.updated；调整为正式 message.delta，确保命名事件确实进入 transport 并推进已应用游标。 |

## 正式 SSE 映射

来源：packages/contracts/src/conversation-events.ts 和 apps/server/src/runtime/events/conversation-event-hub.ts。

| 含义 | PR 旧名称/判断 | main 正式 wire event | 主要 body 字段 |
| --- | --- | --- | --- |
| Operation 开始 | agent_start / run.started | operation.started | sessionId, turnId, runId, turnOrdinal |
| Operation 结束 | session.idle / run.completed 等 | operation.settled | 轮次标识、status、outcome；可带 handledWithoutTurn |
| 工具开始 | tool.updated + startedAt | tool.started | callId/itemId、tool、input、status=running、startedAt |
| 工具增量 | tool.updated | tool.updated | callId/itemId、tool、status=running、可选 partialOutput 与截断信息 |
| 工具结束 | tool.updated + done/error | tool.completed | callId/itemId、tool、status=done/error、output、endedAt；可带 details/presentation |
| 文本增量 | text.updated | message.delta | partId、itemId、text、phase、baseRevision/revision；可带 replace/presentationRole |
| 思考增量 | 旧思考名称 | message.reasoning.delta | 与文本增量相同的内容身份和 revision 结构 |
| 恢复连接 | connection.open | connection.open | 客户端合成的 sessionId/reason，非服务端共享 SSE 名称 |
| 回放缺口 | stream.gap | stream.gap | 触发已建立 live subscription 上的 REST rebase |

正式持久事件 envelope 为 schemaVersion=3，带 workspaceId、sessionId、streamEpoch、eventId、seq、occurredAt、type；eventId 为 streamEpoch:seq。具有 turnId/runId 的记录还带轮次标识与 payload。不要将 Core session 存储 v4 与 SSE v3 混为一谈。

runs 的目标边界是 operation.started、operation.settled、tool.started、tool.completed；tool.updated 增量不能作为新协议边界。迁移这段逻辑和真实协议测试属于阶段 B，本次仅核对并记录。

## 本次验证

运行环境 Node v24.19.0，pnpm 11.19.0。命令使用 `--config.verify-deps-before-run=false`，避免当前 pnpm 自动依赖检查尝试写入不可用的用户 pnpm 目录；项目 packageManager 与 lockfile 未修改。

| 检查 | 结果 |
| --- | --- |
| contracts build | 通过（全项目 build 的第一步） |
| frontend build（tsc -b + Vite） | 通过；有 Vite 大 chunk 提示 |
| frontend lint（oxlint --deny-warnings） | 通过 |
| 9 个定向 Vitest 文件 | 127 通过，1 失败，共 128 用例 |
| git diff --check | 通过 |
| 全项目 pnpm build | 未通过：server 缺少 @earendil-works/pi-ai、@earendil-works/pi-agent-core，伴随类型推导错误 |
| 远端 CI / 浏览器预算 / 全套测试 | 本阶段未运行；属于阶段 D |

定向测试唯一失败：listener.runs-signal.test.ts 的 `invalidates on session.idle...`。main 的共享命名事件列表已不注册 session.idle，因此该旧协议测试无法触发 runs invalidation。这直接确认 R-03，未通过跳过用例或恢复旧白名单掩盖它。其他通过的旧 tool.updated 测试也不证明正式 tool.started/tool.completed 的边界行为正确。

服务器源码、contracts 源码、pnpm-lock.yaml 均无本次改动。全项目构建仍需补齐当前 main 的依赖后复验；代理连接故障阻止正常 Git/包下载，不能据前端构建通过宣称全项目可构建。

## 阶段边界与后续

已交付：最新 main 上的 PR 本地集成补丁、两处冲突的语义处理、协议核对表、前端构建/lint 与定向测试证据。

阶段 A 的全项目构建验收尚受环境依赖阻塞。PR 仍不满足合并条件：
- 阶段 B：R-01 旧 final 覆盖 busy、R-02 catch-up 被旧 count 覆盖、R-03 runs 正式事件边界迁移。
- 阶段 C：idle lifecycle 收敛与连接状态/fallback。
- 阶段 D：最终全项目与浏览器/CI 检查。

本工作区已集成；中间补丁与验证日志保存在 work/。远端 PR 分支的发布结果以本次返回的提交 SHA 为准；代理恢复后可正常 fetch。本环境未挂载约定的 /codex/.../output 目录，因此没有导出到该目录的可下载交付物。

