# PRD v2｜PR #112：后台 SSE 与状态恢复收尾

日期：2026-10-08。审查基线：PR head `53f7b1d789f2aa62e92e02ebf1745cea8ec181e8`，main `410e8daf601f330b8ce5f6c29ac0604858cd767c`。本方案承接用户提供的 v1，替代其剩余阶段 B/C/D 的实施计划。

## 1. 复审结论

上述基线的 quality、CodeQL 均已通过；R-03 正式事件迁移完成。绿色 CI 没有覆盖以下恢复竞态。

| 编号 | 级别 | 已确认事实 | 本次修复 |
| --- | --- | --- | --- |
| R-01 | P1 | session-actions.ts 中 hasTrustedFinal 可覆盖 REST busy，旧回答会放开另一标签页的新执行 | busy 以服务端状态为准，历史 final 不解除发送守卫 |
| R-02 | P1 | Knowledge 的 event ?? latest 沿用 debounce 中的旧 count | catch-up 在窗口内优先且不可被后续 count 撤销 |
| R-03 | 已完成 | operation.started/settled、tool.started/completed 已驱动 runs 边界 | 保留共享协议、150ms debounce 与既有回归 |
| R-04 | P2 | idle 分支可能保留 active/queued；恢复分支硬编码 settled | 共享状态推导，保留 failed/aborted，未知终态采用中性 settled |
| R-05 | P2 | 隐藏关闭 source 未通知 connected=false，Runs/Notebook 会暂停 fallback | 只有真正 OPEN 为 true，CONNECTING/hide/error/cleanup 为 false |
| R-06 | P2 | 初始恢复复用的 monitor 可无限等待 busy/error，connection recovery 缺少 localMutation fence | 四轮有界恢复，增加完整异步身份校验 |
| R-07 | P2 | Session Runs 与 NotebookPanel 同时挂载会各自打开 execution SSE | 按 cwd 共享订阅，最后一个消费者卸载时关闭 |

保留后台断流、applied cursor、gap live fence、共享 SSE v3 名单、去冗余订阅及浏览器预算。服务端 admission 继续是并发提交的最终权威。不改变调度，不引入 WebSocket，不新增 active_run_id/revision 契约。

## 2. 会话恢复

1. is_streaming/is_compacting/pending_message_count 任一 busy 时 working=true；lifecycle 为 active 或 queued。旧 final 只能参与呈现。
2. pending interaction/questionnaire 独立阻止新 prompt。等待用户回复时 working=false、lifecycle=waiting；未配对数据继续阻塞。
3. authoritative idle 后 working=false，保存当前轮次明确 failed/aborted；未知结果 settled 不代表成功。
4. 状态失败不得凭旧 final 解锁，保留可见 error 和停止/重试入口。
5. 恢复专用外层最多四轮，轮间 1 秒，复用既有有界 connection recovery 对 messages/state/artifacts 的读取和历史窗口合并。最后仍 busy/error 时保留保守状态，不通过计时强行解锁。原 prompt monitor 与既有 watchdog 保留自己的职责。
6. 异步提交检查 client、cwd、sessionId、connection/activity/localMutation；分页继续使用 historyWindow fence。切换、live activity 或用户 mutation 使旧恢复无效。
7. 不因连接 OPEN/CONNECTING/CLOSED 直接推断执行 busy/idle。

## 3. Knowledge 与连接状态

Knowledge 的普通事件 1→2→3 在 250ms 内只交付 3。resume/reconnect 设置 needsCatchUp 并清除 buffered count；直至本窗口以 undefined 发出 REST invalidation，随后无版本的 count 不能取消该标记。cleanup 清除 timer 与标记。

通用 JSON SSE 增加 onConnectionChange；创建 CONNECTING、hide、native error、cleanup 通知 false，只有当前 source 的 OPEN 通知 true。过期源回调无效，closeOnError=false 原生重试不变。执行订阅按 cwd 共享连接和 debounce；新消费者获得当前连接状态，单个消费者卸载不关闭其他消费者仍在使用的连接。最后一个消费者卸载时清理 timer、source 和映射。执行订阅透传状态，resume 立即 invalidation，延迟 OPEN 后再次 catch-up。Runs/Notebook 在 CONNECTING 期间保留 5s/30s fallback，隐藏期遵守 refetchIntervalInBackground=false。Research 保留恢复 invalidation。

不以合法的静默 OPEN 连接判定失效：无 heartbeat/revision 证据时任意空闲超时会错误触发轮询。当前承诺覆盖 CONNECTING 和明确 transport error，不声称检测所有半开 socket。

## 4. 实施及验收

| 项目 | 文件/验收 |
| --- | --- |
| 权威状态和生命周期 | session-actions.ts/recovery.ts：旧 final + streaming/compacting/queued 阻止 sendPrompt；busy→idle 收敛；failed/aborted 保留 |
| 有界与迟到结果 | Promise/fake timers：失败→重试、全失败有上限、切换 session/connection/activity/localMutation 不回写 |
| Knowledge | 旧 count→hide→show/OPEN 发 invalidation；catch-up 后新 count 不覆盖；普通 burst/cleanup 保持 |
| 连接与 fallback | event-stream.ts/execution-events.ts：初次 CONNECTING、重复 hide/show、error/retry、cleanup；只有 OPEN 为 true |
| Research | hide/show、首次 CONNECTING、cleanup 后无回调 |
| 浏览器预算 | 双标签页、applied cursor/sentinel/reload/Runs；补充 Knowledge 权威 count、Notebook inspector、Research 和恢复 CONNECTING；按 endpoint multiset 检查隐藏页 0 连接与恢复最多一条 |
| 既有协议 | 正式 operation/tool 边界，tool.updated 输出不刷新 runs |
| 最终验证 | frontend 全测试、typecheck/lint/build、bundle/SSE budget；全项目 quality 与 CodeQL 在新提交上运行 |

竞态使用可控 Promise、fake timers、手动 OPEN；浏览器使用真实 EventSource 和 fixture，不调用生产模型。不得用跳过测试或恢复旧白名单掩盖失败。

## 5. 执行环境及交付

复审期间执行环境离线，本地 shell/写文件工具无法返回。通过授权 GitHub 接口读取同一基线并实施代码/文档；每次分支更新检查 expected_sha，不 force push、不合并 PR。完整检查由新提交的现有 CI 执行，失败则读取日志、修正并再次验证。环境恢复后可补本地验证；不得将旧提交的绿色结果当作新提交证据。

交付本 PRD、修复与回归测试、提交链接、真实 CI 结果，以及更新后的 PR Summary。任何未验证场景必须记录。长期 run identity/revision 增强作为独立后续事项。

## 6. 实施记录

- `59f20c6`：本 PRD 初稿；`cc851ba`：权威 busy/idle、生命周期、有界恢复和竞态回归。
- `c6cec4a`：合并并发修复，保留 Knowledge debounce、连接状态与新增测试。该提交 quality（Linux、Windows、macOS）和 CodeQL 全部通过。
- `23d9ee1`：完成 R-07 共享 execution 连接和 refcount 回归；真实浏览器验收 Knowledge count、Runs+Notebook、Research list/detail 的 hide/show 与 cleanup。本地全量 140 文件/1288 测试通过。
- 收尾复核统一工作状态探测的 known-idle fallback 与 prompt monitor 终态推导，避免覆盖 failed/aborted；工作状态探测增加 client/localMutation fence。新增 3 项回归，相关 3 文件/96 测试、lint、typecheck 通过。最终全项目及跨平台验证以新提交 CI 为准。
- 本轮环境恢复后，frontend lint/typecheck/build、bundle budget、真实 Chromium SSE budget 均通过。浏览器额外验证：Knowledge count 1→隐藏→REST 2；Notebook/Runs 共享一条 execution SSE、隐藏全部关闭、resume 更新输出、卸载最后消费者释放连接；Research list/detail 更新与卸载；execution SSE 被请求 gate 保持 CONNECTING 时，运行中 Notebook 的 5 秒 REST fallback 更新输出，随后 OPEN 正常接管。验收无生产模型调用。
- CONNECTING 的 connection=false 和订阅 refcount 另有确定性单测；原浏览器预算保留会话初次 CONNECTING、双标签页、reload、Runs hide/show。未把静默半开 socket 检测列为完成项。
- 验证结果以当前 PR head 的 Actions 链接为准，不沿用前序提交的通过记录。
