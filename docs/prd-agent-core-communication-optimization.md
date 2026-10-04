# Agent Core 通信与产品协议

当前通信链路为浏览器 REST/SSE → Node 产品服务 → Worker IPC → Core Harness。实现记录见[通信实现](agent-core-communication-implementation.md)。

## 协议边界

浏览器只消费产品命令、状态与事件，不加载 SDK 或凭据。Worker 命令、通知和返回值在 IPC 边界校验；未知命令或无效参数返回可操作错误。

`AgentCoreEventAdapter` 将 Harness 事实投影为 operation、消息、工具、压缩与重试事件。产品层负责 SSE cursor、重放去重、产物、统计和自动复查，不自行推断 SDK 操作已提交或已完成。

## 启动与恢复

1. 启动延迟激活的 Worker。
2. 绑定服务端事件监听，读取并应用 durable snapshot。
3. 激活 Worker，再执行或恢复 operation。
4. IPC 失败、fault 或事件丢失触发恢复；无进展期限额外覆盖 IPC 健康但执行卡住的情况。

稳定浏览器消息 ID 与 operation ID 用于 admission 对账。取消和浏览器交互响应不等待普通配置 mutation 队列，保持活跃任务可停止。

## 历史与配置

历史投影保留消息、工具 details、轨迹和持久结果状态。旧会话首次读取会等待[原子转换](agent-core-session-conversion.md)，并发读取不能看见半转换文件。只读查询不启动模型 Worker。

配置 mutation 串行提交，并以官方 lane 配置为 authority。SSE fence、应用 cursor 与不确定 admission 保护属于可靠交付合同，应保留并持续回归。

## 验收

需要覆盖 IPC 校验、事件绑定顺序、prompt 超时对账、配置竞争、丢失事件、卡死恢复、历史重放、工具生命周期和会话删除。工具能力同时限制发现与执行，不能只从模型可见列表过滤。
