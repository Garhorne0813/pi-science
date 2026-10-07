# Agent Core 运行时目标与边界

Pi Science 使用 `@earendil-works/pi-agent-core` 与 `pi-ai` 0.99.2，依赖精确固定。对话、子代理、研究、复查和标题生成通过独立 Worker 执行。本文替代早期阶段性迁移计划，当前实现见[运行时记录](agent-core-runtime-implementation.md)。

## 运行职责

- `NodeSessionService` 提供产品会话入口；`AgentCoreSessionService` 管理会话、配置、事件绑定和恢复。
- `AgentRuntimeManager` 管理 Worker 容量、归属、关闭及空闲回收。
- Worker 使用官方 Harness 和 `JsonlSessionRepo`；模型配置和 operation 状态以 SDK 持久事实为准。
- 标题、研究与复查使用隐藏任务会话，工具与技能能力由启动参数限制。
- 工具进程使用环境白名单；MCP connector 仅解析各自的凭据绑定。

## 可靠性要求

提示 admission 使用稳定 operation ID 和 `client_message_id` 对账。Worker 延迟激活，服务端先绑定事件并应用 snapshot，再允许恢复执行。配置变更串行提交；关闭等待 Worker 和产品事件写入。

监督同时检查 IPC 健康、事件丢失和 operation 进展。无进展默认期限为 15 分钟，用户交互等待不计入；卡死通过强制终止和持久检查点恢复。自动恢复达到上限后停止并报错。

## 存储与验收

旧 v3 文件通过复制和官方 SDK 写入转换为 v4；原文件保留，消息 ID 映射持久保存。删除标记阻止备份重新出现。转换命令及限制见[会话转换](agent-core-session-conversion.md)。

验收包括真实 Worker 故障、admission 对账、配置竞争、历史恢复、fork、工具能力、MCP 凭据隔离和跨平台 CI。复杂真实旧会话、R 内核和全部平台界面路径仍需独立验证。

## 后续工作

OS 级 sandbox、图片 prompt 新入口及 Pi Durable 1.0 适配分别设计和验收。1.0 的包版本不代表现有会话文件可以直接读取，升级前必须核对存储格式与恢复语义。
