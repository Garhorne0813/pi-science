---
status: resolved
trigger: "重点检查一下对话的机制，找出所有bug；修复所有问题"
created: 2026-07-16
updated: 2026-07-16
---

## Symptoms

- expected_behavior: 新建对话必须生成独立 ID；发送后立即显示运行状态；每个会话只接收自己的事件；断线和刷新后能够恢复；模型、thinking、历史和 Reviewer 状态保持一致。
- actual_behavior: 并发新建会话复用同一 ID；事件可能串到其他会话；发送后状态立即复原并变红；SSE 曾超时；部分回复无文本或显示 unknown；模型 thinking 未正确继承；无法新建或继续对话。
- error_messages: "Conversation stream connection timed out"；顶部状态圆圈很快变红；请求发送后没有持续进度。
- timeline: 自 custom API、模型选择、Reviewer 和会话恢复相关功能陆续加入后多次出现；部分补丁只能短暂缓解。
- reproduction: 快速/并发新建会话；在两个会话同时发送消息；切换路由或刷新后继续发送；忙碌时切换模型或新建会话；SSE 重连后观察状态和事件归属。

## Current Focus

- hypothesis: 单工作区共享 Pi 进程，但会话切换、命令发送和 SSE 消费此前没有共同的串行化及会话绑定；前端又把 EventSource 的存在误当作正确会话已连接，导致竞态、串流和状态丢失。
- test: 修复已有失败单测，再加入并发建会话、双会话 SSE 隔离/重放、连接代次和状态恢复测试。
- expecting: 所有事件携带真实会话归属；并发命令不再复用旧 ID 或泄露事件；前端仅接收当前连接代次和当前会话事件，且可从后端状态恢复 working/model/thinking。
- next_action: 已解决；等待用户手动验收或提交要求。
- reasoning_checkpoint: 已通过运行时实验证明重复 ID、孤儿进程、跨会话同回复和 thinking=off，根因不是单一超时参数。
- tdd_checkpoint: 三项旧测试需适配新的事件元数据、abort 状态刷新和 create_session API。

## Evidence

- timestamp: 2026-07-16T00:00:00+08:00
  observation: 四个并发 new_session 调用返回同一个 ID。
- timestamp: 2026-07-16T00:00:01+08:00
  observation: 四个并发初次创建启动四个 Pi 进程，仅一个被管理器记录，产生孤儿进程。
- timestamp: 2026-07-16T00:00:02+08:00
  observation: A/B 两个会话的 SSE 同时收到相同 777 字节回复，只是被重新标记成不同 session ID。
- timestamp: 2026-07-16T00:00:03+08:00
  observation: 全局配置为 custom-custom-api/gpt-5.6-luna + max，新会话持久化为 thinkingLevel=off。
- timestamp: 2026-07-16T01:40:00+08:00
  observation: 修复后四个并发创建请求返回四个不同 ID；真实状态为 custom-custom-api/gpt-5.6-luna + max。
- timestamp: 2026-07-16T01:43:00+08:00
  observation: 双会话真实联调中，A 运行时 B prompt 返回 409 busy，B SSE 在 A 整轮期间收到 0 个事件；随后 A/B 分别只收到自己的文本和 idle。
- timestamp: 2026-07-16T01:50:00+08:00
  observation: 后端 126 项单测、前端 14 项测试、Ruff 和改动文件 oxlint 全部通过；对话相关 TypeScript 检查无错误。
- timestamp: 2026-07-16T03:10:00+08:00
  observation: 增量审计确认并修复离开对话页误清 working、运行中通过浏览器历史切会话、Custom API 空白会话无法重启、fork 成功但历史读取失败后前后端 ID 分裂、prompt 确认超时提前释放 busy、扩展直接处理命令后永久 busy、快速回复早于 SSE 建连而丢失终止事件等边界缺陷。
- timestamp: 2026-07-16T03:12:00+08:00
  observation: 后端 142 项单测、前端 29 项测试、Ruff、oxlint 和生产构建通过；真实 Luna/max 工具轮次收到完整 bash running/done、最终文本和唯一 session.idle，历史落盘完整，fresh idle SSE 未重放旧轮次。
- timestamp: 2026-07-16T03:38:00+08:00
  observation: 最终回归为后端 150 passed/21 个显式 live integration skipped、前端 37 passed；当前 custom-custom-api/gpt-5.6-luna + max 真实请求收到 7 个 text.updated、唯一 session.idle、精确文本 CHAT_FINAL_AUDIT_OK，历史持久化为 user/assistant。
- timestamp: 2026-07-16T07:48:00+08:00
  observation: 增加连接期间实时事件优先级保护：历史/状态 HTTP 快照较晚返回时，不再用旧的 is_streaming=false 或状态读取错误覆盖已收到的 SSE 活动；新增回归测试后前端 41 passed，后端全量 154 passed/21 skipped，真实 Luna/max 请求仍返回文本与唯一 session.idle。
- timestamp: 2026-07-16T07:52:00+08:00
  observation: prompt acknowledgement timeout/网络歧义失败现在透传 timeout code；前端保留 Stop 直到 Abort，避免后端仍 busy 而 UI 误显示可发送。新增回归测试后前端 42 passed；真实请求 FINAL_REGRESSION_OK 正常收到 6 个 text.updated 和唯一 session.idle。
- timestamp: 2026-07-16T08:12:00+08:00
  observation: 完成第二轮边界审计并修复项目文档版本恢复路径穿越、缺失文件预览错误码、工作区重命名越界/空名、Conda 启动警告，以及 Custom API gpt-5.4 继承 max thinking 导致空响应。后端 158 passed/21 skipped；真实 gpt-5.4 max 与模型切换均返回 MODEL_MAX_COMPAT_OK / MODEL_SWITCH_MAX_OK；知识文件 accept、undo、PROJECT.md 写入和恶意版本路径 HTTP 验收通过。

## Eliminated

- hypothesis: 仅仅是 EventSource 建连慢，需要延长 waitUntilConnected 超时。
  reason: 后端已复现跨会话事件串流、重复 ID 和孤儿进程；等待更久无法修复状态归属和并发竞态。

## Resolution

- root_cause: 单工作区共享 Pi 进程的 session switch 与 prompt 并非原子操作；stdout/SSE 使用全局活动会话重新标记事件；前端只判断 EventSource 是否存在而不校验目标会话，并在重连时清空/重复监听器。另有 custom models.json 将 reasoning 硬编码为 false、SSE 数字游标跨进程复用、历史工具结果丢失 toolCallId、Reviewer 副作用依赖 SSE 消费等独立缺陷。
- fix: 增加工作区锁和原子会话命令；按真实会话分区事件历史/订阅并增加进程代次游标；SSE 附着不再切换会话；启动/删除/abort/模型/交互路径加入状态确认和错误恢复；前端使用连接代次、目标会话校验、单监听器和后端 state 恢复；实现交互卡片、完成后历史重同步、首条消息命名；custom reasoning 模型自动声明 max 能力；Reviewer 改为 dispatch 观察者并加入去抖、串行和输入上限。增量审计又补充了跨页面持续连接、运行中路由保护、空白 Custom API 运行时替换及新 ID 接管、fork 部分失败恢复、prompt ack 守卫、扩展无 agent turn 的合成 idle，以及 SSE 晚建连完成状态兜底。
- verification: 158 backend tests passed and 21 live-model integration tests are opt-in; 42 frontend tests passed; Ruff, oxlint, npm audit (0 vulnerabilities), shell syntax, diff check and production build passed; four-way concurrent create produced distinct IDs; Luna/max real prompts returned CHAT_AUDIT_DONE, CHAT_FINAL_AUDIT_OK, REAL_API_UAT_OK and FINAL_REGRESSION_OK with complete lifecycle and durable history; gpt-5.4 with workspace thinking=max returned MODEL_MAX_COMPAT_OK; fresh idle SSE returned zero replay bytes; dual-session SSE isolation and busy rejection passed; stale HTTP state snapshots no longer clear live SSE working activity, ambiguous prompt acknowledgements keep Stop visible until Abort, knowledge accept/file move/undo passed, and unsafe version restore is rejected. Browser UAT scripts remain unexecuted because local Chrome exits with SIGABRT before page creation.
- files_changed: backend/api/settings.py, backend/api/sessions.py, backend/api/provenance.py, backend/api/workspaces.py, backend/models/__init__.py, backend/services/event_normalizer.py, backend/services/file_service.py, backend/services/pi_manager.py, backend/services/project_knowledge_store.py, backend/services/reviewer_service.py, backend/pyproject.toml, backend/tests/test_event_normalizer.py, backend/tests/test_files.py, backend/tests/test_health.py, backend/tests/test_project_knowledge.py, backend/tests/test_provenance.py, backend/tests/test_sessions.py, backend/tests/test_settings.py, frontend/src/app/layout/ProjectsLayout.tsx, frontend/src/app/routes/LiveSessionPage.tsx, frontend/src/lib/pi-science-client.ts, frontend/src/lib/runtime-store.ts, frontend/src/lib/pi-science-client.test.ts, frontend/src/lib/runtime-store.test.ts, scripts/dev.sh
