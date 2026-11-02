# 审批模式热切换（PR #165 基线）

实现附件的四个阶段。模式及 revision 继续由现有会话权限文件负责；派发屏障只记录切换是否尚未完成，不存储另一份权限真值。

## 阶段 1、2：常规切换与首次创建

- 空白页选择模式只保存按工作区隔离的草稿，不创建 Session 或 Worker。首次创建时以 `initialApproval` 一次传入；Full access 需要显式确认。
- Worker 在真实 Session 元数据创建后、工具和 MCP 初始化前保存初始权限。初始化、注册或激活失败会清理新会话及权限文件。
- 模式修改与正常任务、删除使用会话互斥。拒绝主任务、审批、消息队列、后台子任务、启动和恢复中的切换；同模式、同 revision 为 no-op。
- 无需回收的切换保留 Worker、MCP 和内核。每个执行入口继续读取最新会话策略。

## 阶段 3：权限版本与定向回收

- Worker 的 `begin_approval_change` 在读取权威快照前建立派发屏障，阻止 prompt、steer、follow-up、compaction 等进入；持久化完成并确认新 revision 后才释放。
- 控制平面的屏障同时阻止迟到的内核请求和受限子任务授权，覆盖“已回收旧资源、尚未提交新模式”的窗口。
- 内核签名能力包含审批 revision。请求出队后、内核启动后真正执行前再次校验；旧签名在模式变化后失效。
- 可独立回收的会话内核先停止并验证退出，再保存模式；保留 Worker 和不持有会话 OS 权限的远程 MCP 连接。内核重置会清除变量，UI 会单独提示。
- 从 `full` 降权、存在按会话权限启动的本地 MCP 进程、能力状态未知或恢复一次失败的切换时，继续使用完整 Worker 回收路径。没有强行实现所有 full 切换无重启。
- MCP 调用在调度队列出队后比较审批 revision；旧自动授权或旧用户授权不能跨 revision 继续派发。
- 审批文件与历史聊天不需要迁移。旧格式的受限执行授权缺少可靠的权限版本绑定，因此恢复时要求重新派发任务，不继续使用旧授权。
- 新建受限子任务的授权记录绑定父会话权限文件及 revision。恢复、后代授权和长期进程的源文件检查都能撤销旧能力；修改会话模式不会让子任务取得更宽权限。
- 回收失败不丢弃待清理资源引用；在真正退出前不会从内核登记表移除。失败后阻止执行，可重试回收。GET 在未完成时返回 `transitionPending`，界面提供重试按钮。
- PUT 返回 `mode`、`revision`、`runtimeRestarted` 和 `kernelRestartCount`。409 区分 `approval_revision_conflict` / `session_busy`；503 为 `permission_transition_failed`，尽可能附最新状态。

Notebook 当前使用**定向关闭**方案，没有原地扩大或收紧内核 OS 沙箱。相同模式 no-op 保留变量；需要修改内核权限的切换会清除变量。这是文档第三阶段允许的安全实现路径。

## 阶段 4：独立默认值、同步与观测

- Settings → Agent 提供“新对话默认审批模式”，仅允许 `ask` / `auto`，初始 `ask`。已有会话、历史恢复及明确选择过模式的草稿保持独立；`full` 不进入全局默认值。
- GET/PUT `/api/settings/approval` 读写 `{ defaultMode }`，只影响之后创建的会话，不重载现有运行环境。显式 `initialApproval` 优先于默认值。
- 成功切换后发布持久化会话事件 `approval.mode.changed`。不同设备只要订阅当前会话的 SSE 即可收到通知；浏览器重新 GET 并只接受不旧于本地 revision 的响应。另保留 BroadcastChannel 和窗口恢复焦点时刷新。
- Settings → Agent 的“审批切换性能”展示当前服务进程最近 1000 条记录，按切换方向统计成功 P50/P95、失败、慢切换以及 Worker/内核重置。刷新统计不修改任何会话。
- GET `/api/settings/approval-metrics` 仅返回聚合数据，不暴露 Session ID、工作区路径或凭据；记录有容量上限，服务重启后清空。
- diagnostics channel `pi-science.approval-change` 输出切换方向、结果、total/validation/persistence/resource_revoke 耗时和 Worker/内核计数。`mcp_reconnect_count` 表示被回收、下次启用时需重新连接的本地 MCP 进程数；实际连接在会话恢复时建立。

## 回退与验证

### 并发工具审批

同一会话的权限请求按顺序展示，逐次允许只批准对应调用。MCP 与网络访问还通过 Worker IPC 向控制平面申请按授权目标隔离的 FIFO 租约：MCP 绑定项目、connector、tool 和配置版本；网络绑定 profile 和目标地址。取得租约后重新读取权威权限并验证 MCP 连接指纹，再决定是否显示审批卡。隐藏 delegated agent 仍要求预授权，不进入交互审批。

MCP 的 Always allow 先由 Worker 确认请求仍待处理，再保存权限和刷新投影，最后完成该请求并释放租约。保存失败仍按原有单次批准语义继续，等待调用重新检查后各自申请审批。网络租约同样覆盖保存授权；永久拒绝可阻止后续请求，单次拒绝不复用。租约在审批结束后释放，实际工具执行仍可并发，派发前继续执行原有的权限、配置与 revision 检查。

取消会移除排队请求，Worker 退出会回收它持有或等待的租约。队列只存在于当前控制平面进程，不跨独立服务进程协调；服务重启后旧 Worker 与租约一同失效。远程执行和 Slurm 复用会话展示队列，但每个命令／脚本仍逐次批准，不增加永久授权。

可信服务端设置 `PI_SCIENCE_APPROVAL_HOT_SWITCH=0` 会让实际模式变化恢复完整 Worker 回收路径；默认启用符合安全条件的热切换。客户端不能选择绕过资源回收。

针对性回归覆盖模式与 revision、静止状态、派发屏障、回收失败、内核实际变量清除、MCP 排队授权失效、受限任务授权恢复、默认值隔离、Full access 确认、SSE 通知和设置页交互。平台沙箱验收仍受测试主机可用隔离能力影响；本地性能结果不替代生产部署验收。

可复现本地基准：

```sh
pnpm --filter @pi-science/server exec tsx src/cli/benchmark-approval.ts 100
```

基准创建临时工作区和真实 Worker，仅执行模式切换，不发送 Prompt 或执行外部工具，最后清理临时状态。2026-10-23 本地 cloud Linux / Node 24 的一次运行（trusted-host，无持久内核/MCP，预热 4 次后采样）：

| 切换方向 | 样本 | P50 | P95 | Worker 重启 |
| --- | ---: | ---: | ---: | ---: |
| ask → auto | 50 | 3.24 ms | 19.40 ms | 0 |
| auto → ask | 50 | 3.15 ms | 10.29 ms | 0 |

这次测量包含真实 Worker IPC 和持久化；不包含工具执行、网络连接、需要撤权的持久资源以及多用户生产负载。两方向在该本地场景均低于建议的 P95 300 ms 目标。
