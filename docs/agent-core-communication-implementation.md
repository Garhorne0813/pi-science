# Agent Core 通信实现记录

当前实现按[产品协议说明](prd-agent-core-communication-optimization.md)运行，浏览器通过 REST/SSE 与 Node 服务通信，服务端通过结构化 IPC 管理独立 Core Worker。

| 层 | 实现 |
| --- | --- |
| IPC | `worker/command-contract.ts`、`worker/protocol.ts`：命令、通知、关联响应与 snapshot 校验 |
| 客户端 | `AgentCoreRuntimeClient`：请求期限、错误分类、退出清理与关联结果校验 |
| Worker | `SessionRuntime`：SDK、工具能力、配置 mutation、延迟激活和 pending interaction 状态 |
| 投影 | `AgentCoreEventAdapter`：稳定 operation 生命周期、消息、工具、压缩和重试进展 |
| 产品服务 | `AgentCoreSessionService`：先绑定/读 snapshot 后激活；admission、配置与恢复串行管理 |
| 产品事件 | `ConversationEventHub`：观察者持久化、SSE cursor/去重、关闭 drain 和交互恢复 |
| 后台任务 | Core 研究、复查和标题 Worker：结构化结果、隐藏会话、取消及清理 |

真实本地 provider stream 永久停住时，Worker IPC 仍能返回 busy snapshot。watchdog 的进展期限会强制终止旧 Worker，从同一 durable operation 恢复，并保持浏览器消息 ID 去重。连续卡死达到恢复上限会停机报错，保留显式重试路径。

空工具列表或非 MCP 能力不启动 MCP discovery；允许单个 MCP 工具时，只解析匹配 connector 的凭据并连接它，再过滤工具。managed include/exclude 与确认策略继续生效。

测试覆盖 IPC、真实进程退出、卡死恢复、用户交互等待、配置竞争、迁移并发、删除 tombstone、标题清理、历史及产品副作用去重。最终跨平台结果以提交对应的 CI 为准，未执行的界面或外部服务路径需单独记录。
