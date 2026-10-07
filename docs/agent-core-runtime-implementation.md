# Agent Core 运行时实现

当前依赖为 `pi-agent-core` / `pi-ai` 0.99.2。整体架构见[架构说明](architecture.zh-CN.md)，能力范围见[能力清单](agent-core-capability-inventory.md)。

| 入口 | 实现与职责 |
| --- | --- |
| 对话 | `AgentCoreSessionService`：v4 会话、串行配置、稳定 admission、生命周期与恢复 |
| 子代理 | 服务端 dispatch 和隐藏 Worker：single、chain、parallel、取消与容量限制 |
| 研究/复查 | Core runner：结构化结果、usage、schema 修复、期限和停止 |
| 标题 | 临时隐藏 Worker，禁用工具和技能，完成或关闭时清理 |
| 模型 | pi-ai 官方目录和配置的 provider/endpoint，支持 canonical 模型引用 |
| 工具 | read/bash/edit/write、todo、Notebook、问卷与 MCP SDK 适配 |

Worker 延迟激活，服务端完成事件绑定与 snapshot 后才启动 drive/resume。提示使用稳定 operation ID 与浏览器消息 ID 对账，超时不代表未提交。模型与思考档以官方 lane 配置为 authority。

watchdog 不把成功读取状态当作进展；当前 operation 长时间没有模型、工具、压缩或重试事件时，会强制终止 Worker 并恢复检查点。等待问卷与权限确认的时间除外。连续恢复上限和配置见[监督说明](agent-core-session-conversion.md#运行监督和工具能力)。

MCP 在启动前执行能力检查；受限 Worker 仅解析和连接允许的 connector，发现结果再与完整工具能力及 managed include/exclude 策略取交集。

旧 v3 转换、registry、tombstone 和消息 ID 映射见[转换说明](agent-core-session-conversion.md)。自动化测试覆盖历史、fork、工具结果、关闭、恢复、能力与凭据隔离；跨平台结果应以目标提交的 GitHub CI 为准。

OS 级 sandbox、真实用户所有复杂 v3 样本、新文件降级读取以及全平台逐项界面验收不由上述测试自动证明。
