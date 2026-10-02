# Agent-core 通信收敛实施记录

日期：2026-10-02。基线：PR #115 的 `59be3309e29334750ddfe307a1ae4aa89b17c304`。

本记录对应 [通信优化方案](prd-agent-core-communication-optimization.md) 的第一批改造。默认 Orbit、core opt-in、现有 REST/SSE、持久化文件和 Sandbox 暂缓的约定继续适用。不能把这一批交付解释为整份方案完成或 Orbit 可以退役。

## 已实现的内部边界

| 边界 | 所有者与消费者 | 本批行为 |
| --- | --- | --- |
| Worker 命令和通知 | `agent/worker/command-contract.ts`；host client、Worker 分派 | 25 个命令关联参数和结果类型；两侧校验参数；非法输入返回原有类别错误码，诊断不回显参数 |
| Worker 初始化和 IPC 包装 | `agent/worker/protocol.ts`、`main.ts` | 校验包类型、关联 ID 和启动选项；非法关联响应立即结束 pending 请求 |
| 执行状态/配置事实 | `command-contract.ts`、`SessionRuntime` | 校验 snapshot、已应用配置、operation result、历史消息入口和 usage；失败结果保留错误语义 |
| Worker 事件 | `events/product-input.ts`、`AgentCoreEventAdapter` | core 发出 operation/message/tool/compaction/interaction/subagent 产品输入；host 拒绝未知或非法事实 |
| 内容片段 | core adapter；legacy 内容解析器 | core 消费 SDK replay frame 或内容事实，增量仅携带内容和消息身份，不再附带完整累积消息；legacy 解析 `assistantMessageEvent`；投影不再解析旧消息 wrapper，前缀兼容推断仅用于 legacy |
| 共用产品投影 | `ConversationEventHub` | 接收统一输入，继续发布现有 SSE；同一 turn 的同一模型错误不会重复生成卡片 |
| 产物、复查、统计 | `DurableTurnLifecycle`、observer、stats projector | 消费统一名称，保持持久化 skill 事件和浏览器事件格式；继续等待 observer/子代理 drain |
| 研究/复查结果 | `TaskRuntime`、两个独立 task runner | core 直接返回 durable 文本和 usage；Orbit 的增量解析、退出、期限与监听器清理由 `OrbitTaskRuntime` 承担 |

研究与复查分别保留自己的 schema、JSON 修复次数、期限、预算/usage 和关闭策略；没有把两套产品状态机合成通用 runner。取消继续通过对应 manager 停止执行。Core 查询 durable usage 用于补齐重放没有 live usage 的情况，并保留失败花费。

每次 Worker 打开生成新的 `runtimeEpoch`，snapshot 与事件携带同一 epoch；事件 sequence 在该 epoch 内递增。这与产品 SSE `streamEpoch`/cursor 分开。订阅 → snapshot → activate、有界恢复和 operation 对账继续由 core 会话服务负责。本批没有替换现有恢复算法。

## 基线及变化

下面是可复查的静态计数，不是性能降幅。两次统计比较同一文件与上述基线。

| 指标 | 基线 | 本批 |
| --- | --- | --- |
| `core-runner-runtime.ts` 中合成事件的 `this.emit("event", …)` 调用点 | 4 | 0 |
| 通用 runtime 接口中的 `LegacyOrbitTransport` | 1 | 0 |
| 公共 runner 接口对 `PiResult`/EventEmitter 的依赖 | 有 | 无 |
| core 消息增量中的 `assistantMessageEvent` wrapper | 有 | 无 |
| `NodeSessionService` 中 `agentCore.owns` 调用点 | 10 | 10；尚未集中后端分派 |
| core 隐藏任务首个 prompt 的初始化/运行 `get_state` 调用数 | 2 | 1；省去 runner 额外初始化查询 |
| 新增浏览器协议或 Conversation Snapshot API | 无 | 无 |

Core 对话仍需要“SDK 事实 → 产品输入 → SSE”的执行与发布边界，本批不声称转换层数或事件字节数已经减少。结构化任务结果省去结果再合成流再解析的往返；首 token 延迟、总事件字节、恢复时间和 shutdown 时间尚没有同环境性能基线，不给出百分比收益。

## 完成边界和下一批

| 方案阶段 | 当前状态 |
| --- | --- |
| A | 已盘点本批生产者、消费者和可靠性所有者；静态基线已记录，性能基线待采集 |
| B | 命令/通知和关键结果校验已接入；保留一处字符串命令入口供已有产品路由使用，SDK 深层记录没有另建整套 schema |
| C | core 独立产品输入与共用内容投影已接入；普通文本/工具轨迹对照和错误去重已覆盖，完整能力与故障验收继续由既有回归验证 |
| D | 结构化 research/review runner 已实现；集中会话后端解析、拆出 Orbit 会话恢复与共享配置解析尚未实施 |
| E | 本批验证浏览器兼容性；尚未删除前端可靠交付/补洞分支，后续只有具备替代证据的分支才删除 |

下一批重点是有限会话后端接口及 legacy 会话实现的拆分。保留 v3/v4 归属、删除标记、冷态查询和 rollout 规则，不通过全局开关把已有 core 会话送回 Orbit。本批搜索前端 runtime/client/projection，没有发现调用 core/Orbit 原始执行协议的分支；相关 Orbit 引用为登录提示、注释或无关视觉组件。前端清理需先列出具体候选及替代证据；SSE fence、已应用 cursor、稳定 client ID 和不确定 admission 不属于可直接删除的兼容代码。

## 验证记录

本地验证：

- 服务端全量串行测试：947 通过，15 跳过；最后的内容载荷/类型调整后，agent/events 相关 118 项再次通过。
- 前端：1,227 通过；contracts：13 通过；skills：28 通过。
- 全项目类型检查、全项目构建、frontend lint 与 bundle budget 通过；最终服务端类型检查和构建再次通过。
- 新增 IPC 校验、非法关联结果立即失败、退出清理、Worker epoch 重开、core/legacy 文本工具轨迹对照、错误去重、replay frame、Orbit 快速完成/拒绝/期限/失败 spend 回归。
- MCP 凭据存储测试的远程 endpoint 夹具改为固定公共 IP，避免只验证存储与投影的测试依赖外部 DNS；产品出站校验没有修改。

第一轮并行执行时出现短期限 Worker 测试超时，串行复跑通过；最终全量使用串行文件执行。本批提交后的 Linux/Windows、macOS launcher 和 CodeQL 结果需从 PR CI 独立确认。真实用户研究、扩展等价能力与 Orbit 退役验收仍待完成，不能用本地单元测试代替。

B/C 与 D 的 runner 部分依赖同一套内部事件名，作为一个可回退的原子代码批次提交；回退本批不改变会话归属、前端协议或已有会话文件。
