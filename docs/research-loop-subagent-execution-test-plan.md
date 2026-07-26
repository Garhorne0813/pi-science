# Research Loop Subagent 架构执行与测试方案

## 1. 结论与实施边界

本方案保留 PR #2 的核心思想：持久化 Research Loop、候选方案快照、隔离执行、结果评估、预算和停止条件；将原来依赖调用方手工推进的 `propose -> execute -> evaluate` 改为由专用 supervisor 调度多个 subagent 自动推进。

推荐不要直接合并 PR #2 后继续堆补丁，而是从最新 `main` 新建分支，选择性移植其 contracts、事件模型、JobCoordinator 执行目录和 Research UI。以下部分需要重新设计：并发事务、subagent 编排、可信评估、重启恢复和 workspace rename 协调。

核心原则：

- Node 是唯一控制平面和状态权威。
- `pi-subagents` 是推理执行引擎，不直接决定 loop 状态、预算或是否完成。
- subagent 只能提交结构化提案、分析和诊断；代码执行、文件校验、指标计算由 Node 管理。
- 所有长任务必须先持久化“已预留”状态，再启动外部进程。
- 所有阶段必须支持幂等重试和服务重启恢复。
- MVP 先支持 serial loop；parallel candidate 留到 serial 稳定之后。

## 2. 已确认的代码基础

- Node 已拥有 session、SSE、JobCoordinator、workspace 安全校验和持久化能力。
- `runtime/pi/node_modules/pi-subagents` 已安装，支持 builtin/custom agent、异步运行、状态文件、interrupt/stop 和 supervisor 通信。
- Pi runtime 已默认加载 `pi-subagents` 扩展。
- 项目已有 `.pi/agents/` 的前端配置界面，但服务端目前只有列表接口，缺少 PUT/DELETE；研究循环不能依赖该界面完成系统 agent 注册。
- PR #2 的研究循环实现存在手工推进、并发重复执行、重启后 observer 丢失和 evaluator 未执行等问题，新架构必须从数据模型层解决，而不是只增加前端调用。

## 3. 目标架构

```text
User / Conversation UI
        |
        v
ResearchLoop API
        |
        v
Node Research Orchestrator  <----> Durable event log / command ledger
        |
        +---- Research Supervisor Pi session
        |          |
        |          +---- planner subagent
        |          +---- candidate-builder subagent
        |          +---- critic subagent
        |          +---- result-analyst subagent
        |
        +---- JobCoordinator ----> isolated candidate execution
        |
        +---- Deterministic Evaluator ----> metrics + hard checks
        |
        +---- Reconciler ----> restart recovery / retry / cancellation
```

### 3.1 角色划分

| 角色 | 职责 | 默认工具权限 | 是否能改变 loop 状态 |
| --- | --- | --- | --- |
| Research Supervisor | 根据 Node 提供的阶段任务调用合适的 subagent，并返回结构化结果 | `subagent`，只读上下文 | 否 |
| Planner | 分解目标、提出实验策略和约束 | read/grep/find/ls | 否 |
| Candidate Builder | 生成候选文件、入口脚本和 approach summary | 默认只读；通过结构化结果返回文件 | 否 |
| Critic | 比较历史结果，诊断失败，建议下一轮方向 | read/grep/find/ls | 否 |
| Result Analyst | 对执行日志和确定性指标做解释、生成 findings | read/grep/find/ls | 否 |
| Node Orchestrator | 状态转换、预算、幂等、调度、重试和停止判断 | 内部服务权限 | 是 |
| Deterministic Evaluator | 运行受控 evaluator，计算正式指标和 hard checks | JobCoordinator 隔离执行 | 只能返回数据 |

MVP 不允许 Candidate Builder 直接修改用户 workspace。它必须返回符合 schema 的文件映射，Node 校验路径和大小后创建不可变 snapshot。后续如果需要处理大型候选，再增加受限 staging directory，而不是开放整个 workspace 写权限。

### 3.2 Supervisor 运行方式

每个 loop 创建一个独立、隐藏的 Pi supervisor session：

- session 文件放在 `.pi-science/research-sessions/<loop_id>/`，不混入普通会话列表；
- 加载 `pi-subagents` 扩展；
- Node 每次只发送一个明确阶段任务，例如 `plan_round`、`build_candidate`、`analyze_result`；
- supervisor 可以调用子 agent，但必须以严格 JSON envelope 返回结果；
- Node 使用 Zod 校验结果，失败时最多进行两次修复提示，之后把阶段标为失败或等待人工处理；
- supervisor/session ID 和 pi-subagents async run ID 都写入持久化记录，供重启后查询和恢复。

不建议让前端直接调用 subagent，也不建议让 subagent 直接调用 loop 状态 API。这样可以避免浏览器关闭、重复请求或 prompt injection 改变控制状态。

## 4. 数据模型与状态机

### 4.1 新增核心记录

在 PR #2 记录类型基础上增加：

- `loop.command_reserved`
- `loop.command_completed`
- `loop.command_failed`
- `agent.run_reserved`
- `agent.run_started`
- `agent.run_completed`
- `agent.run_failed`
- `candidate.execution_reserved`
- `candidate.evaluation_reserved`
- `candidate.diagnosed`
- `loop.recovery_started`
- `loop.recovery_completed`

每个 mutation 都必须包含：

- `operation_id`
- `idempotency_key`
- `expected_revision`
- `loop_id`
- `candidate_id`（适用时）
- `causation_id`
- `correlation_id`
- `attempt`
- `created_at`

### 4.2 Loop 状态

```text
draft -> ready -> running -> pausing -> paused
                    |          |
                    |          +-> paused
                    +-> cancelling -> cancelled
                    +-> completed
                    +-> failed
```

`pause` 的定义是“停止启动下一阶段”。默认不强杀正在执行的 candidate；UI 必须显示 `Pausing — current execution will finish`。如果产品需要立即停止，提供单独的 `Pause and stop current run` 操作。

### 4.3 Candidate 状态

```text
proposed
  -> execution_reserved
  -> executing
  -> execution_succeeded / execution_failed
  -> evaluation_reserved
  -> evaluated
  -> diagnosed
```

状态由 reducer 从事件重建，禁止各接口自行拼接不一致的状态。

### 4.4 原子预留模式

任何外部副作用都采用以下顺序：

1. 在 workspace mutation lock 内读取最新 revision。
2. 校验状态、预算和幂等 key。
3. 追加 `*_reserved` 事件并提交。
4. 释放锁。
5. 启动 subagent 或 JobCoordinator。
6. 再次进入锁，追加 started/completed/failed 事件。

这样 concurrent execute、cancel/execute 和重复 evaluate 都不会生成两个有效操作。取消逻辑既检查 started，也检查 reserved 操作。

## 5. 单轮自动执行流程

### 阶段 A：创建和预检

1. 用户输入 objective、预算、指标和约束。
2. Node 创建 draft，不自动注册一个没有实现的 evaluator。
3. preflight 检查：模型、pi-subagents、agent definitions、执行环境、evaluator、预算和 workspace 权限。
4. 用户确认本地代码执行权限后进入 ready/running。

### 阶段 B：规划与候选生成

1. Node 生成 `RoundContext`，只包含必要的 objective、约束、历史摘要、frontier 和预算余量。
2. Supervisor 调用 Planner；第一轮生成策略，后续轮调用 Critic 生成改进方向。
3. Candidate Builder 返回：

```ts
{
  approach_summary: string;
  rationale: string;
  files: Record<string, string>;
  entrypoint: string;
  parent_candidate_ids: string[];
  expected_artifacts: Array<{ path: string; kind: string }>;
}
```

4. Node 校验安全相对路径、重复路径、单文件/总大小、入口文件和 digest。
5. Node 创建不可变 candidate snapshot。

### 阶段 C：执行

1. 原子预留 execution。
2. 将 snapshot 复制到 `.pi-science/runs/<run_id>/work`。
3. JobCoordinator 在 work 目录运行入口脚本，只注入白名单环境变量。
4. stdout/stderr 使用流式上限和尾部保留，产物只允许写入 outputs 目录。
5. Job 完成事件由持久化 reconciler 观察，不依赖单个内存 Promise。

### 阶段 D：可信评估

1. deterministic evaluator 从 outputs 读取结果并输出固定 schema 的 `evaluation.json`。
2. Node 验证指标名称、方向、数值范围、hard checks、artifact digest 和路径。
3. Result Analyst subagent只能生成解释、findings 和下一轮建议，不能覆盖正式指标或把 hard check 改成 passed。
4. 如果未来支持 LLM judge，必须把该指标标记为 `llm_judged`，记录模型、prompt digest、重复评审结果和一致性，不能伪装为 deterministic metric。

### 阶段 E：停止或进入下一轮

Node 独立计算：

- target metrics；
- max candidates；
- active wall time；
- token/cost；
- patience；
- min improvement；
- 用户 pause/cancel；
- 连续基础设施失败次数。

没有达到停止条件时，由 Critic 基于失败诊断和 frontier 生成下一轮 strategy，再回到阶段 B。

## 6. 重启恢复与取消

新增 `ResearchLoopReconciler`：

- 服务启动时扫描所有非终态 loop；
- 查询 pi-subagents lifecycle `status.json/events.jsonl`；
- 查询 JobCoordinator 持久化 job 状态；
- 对 reserved 但未 started 的操作判断是否安全重试；
- 对 job 已完成但缺少 execution_finished 的记录补写事件；
- 对 agent run 已完成但结果未消费的记录重新读取结果并校验；
- 对找不到外部 run 的操作标记 `lost`，按 retry policy 重试或进入 `needs_attention`；
- recovery 本身也有 operation ID，确保重复启动不会重复补写。

取消顺序：先持久化 `cancelling`，再停止 supervisor/subagent async runs 和 JobCoordinator jobs，确认或超时后进入 `cancelled`。任何晚到结果必须因 loop revision/terminal state 不匹配而被忽略，但仍记录为审计事件。

## 7. 推荐代码结构

```text
apps/server/src/research-loop/
  contracts.ts
  repository.ts
  reducer.ts
  service.ts
  orchestrator.ts
  reconciler.ts
  subagent-runner.ts
  supervisor-runtime.ts
  candidate-snapshot.ts
  deterministic-evaluator.ts
  stop-policy.ts
  routes.ts

apps/server/resources/research-agents/
  supervisor.md
  planner.md
  candidate-builder.md
  critic.md
  result-analyst.md

packages/contracts/src/research-loop.ts
frontend/src/lib/research-loop-api.ts
frontend/src/app/routes/ResearchPage.tsx
frontend/src/components/conversation/ResearchLoopControls.tsx
```

系统 agent definitions 应由应用版本控制，并在 runtime 启动时从 app-owned 目录加载；用户 `.pi/agents` 只用于可选覆盖，不能成为系统功能存在的前提。

## 8. 分阶段执行计划

### Phase 0：决策和基线

- 新建分支于最新 main。
- 记录 ADR：Node authoritative orchestration、serial-first、deterministic metrics、hidden supervisor sessions。
- 将 PR #2 可复用内容按文件列出，不直接整体 merge。
- 修复或明确推迟 Settings subagent PUT/DELETE；系统 agent 不依赖该功能。

验收门：当前 main 全量测试保持通过。

### Phase 1：领域模型和持久化

- 拆分 contracts、repository、reducer 和 stop policy。
- 实现 revision、operation ID、幂等和原子预留。
- 正确实现 active wall time、patience 和 min improvement。
- 增加日志索引/快照，避免每次完整重放无限增长的 JSONL。

验收门：纯 reducer 和并发 repository 测试通过，不启动 Pi 或真实 job。

### Phase 2：Subagent Runner

- 实现隐藏 supervisor runtime。
- 加载 app-owned research agent definitions 和 `pi-subagents`。
- 实现结构化请求/响应、schema repair、超时、interrupt、token/cost 采集。
- 提供 `FakeSubagentRunner`，CI 不依赖外部模型。

验收门：fake runner 与模拟 Pi process 均能完成、失败、超时、取消和恢复。

### Phase 3：Serial Orchestrator

- 实现单轮 plan/build/execute/evaluate/diagnose。
- 所有阶段使用 durable command ledger。
- 实现 pause、resume、cancel 和 stop policy。
- 暂不支持 parallel candidate。

验收门：一个 fake research loop 能自动完成至少三轮，并因 target/patience/budget 正确停止。

### Phase 4：可信执行和评估

- 强化 JobCoordinator execution_cwd、环境变量白名单和输出限制。
- evaluator 作为真正的受控执行步骤，不接收调用方自报 hard check。
- 记录 artifact digest、evaluator digest 和 provenance。

验收门：伪造指标、路径逃逸、symlink、篡改 artifact 和重复 evaluate 均被拒绝。

### Phase 5：恢复与运行维护

- 实现启动 reconciler、退避轮询和 lost-run 策略。
- workspace rename 时阻止活跃 loop，或事务性迁移所有绝对路径并重启 runtime；MVP 推荐有活跃 loop/job 时禁止 rename。
- 增加事件日志压缩、索引和 retention。

验收门：在每个生命周期阶段强制重启 Node，最终状态与未重启执行一致。

### Phase 6：前端接入

- Conversation 的 Research 模式真正调用 `create + start`，随后由服务端自动推进。
- 前端只订阅/轮询状态，不负责触发下一阶段。
- 展示当前 agent、round、budget、candidate、job、evaluation 和 needs-attention。
- 明确区分 Pause、Pause after current run、Cancel。
- 页面刷新或切换路由后恢复 active loop。

验收门：用户从新对话启动研究后能看到 candidate 自动产生并执行，不再停在 `Awaiting candidate`。

### Phase 7：真实模型 UAT 与灰度

- 默认 feature flag 关闭。
- 使用受控 workspace 和小预算运行真实模型 smoke test。
- 收集 token、cost、成功率、无效结构化输出率和平均恢复时间。
- 达到验收指标后再默认开启 serial research loop。

## 9. 测试方案

### 9.1 Unit tests

- reducer 对每个合法/非法状态转换的处理。
- operation reservation 和 idempotency。
- active wall time 不计算 draft/paused 时间。
- target、patience、min improvement、token/cost 和 candidate budget。
- subagent JSON schema、repair 次数和超大响应限制。
- candidate path、重复路径、入口文件和 digest。
- deterministic evaluator schema 和 artifact digest。
- late result 在 cancelled/completed loop 上不会改变状态。

### 9.2 Concurrency tests

- 两个 execute 请求只产生一个 job。
- execute 与 cancel 竞态不会留下 orphan job。
- 两个 evaluate 请求只产生一个 evaluation。
- start/pause/cancel 并发后 reducer 得到唯一合法状态。
- 两个 reconciler 实例不会重复补写完成事件。
- 相同 idempotency key 在进程内和重启后都返回同一结果。

### 9.3 Restart and recovery tests

分别在以下时间点终止并重启 server：

- agent reserved、尚未 started；
- subagent running；
- subagent completed、尚未消费结果；
- execution reserved；
- job running；
- job completed、尚未写 execution_finished；
- evaluation running；
- loop cancelling。

每项验证：没有重复 subagent/job、没有永久 running、预算不重复扣除、最终记录链完整。

### 9.4 Integration tests

- FakeSubagentRunner + 真实 JobCoordinator 完成三轮研究。
- 无效 candidate 第一次 repair 成功。
- 连续无效输出达到上限后进入 needs-attention。
- execution failure 进入 Critic 诊断并生成下一候选。
- evaluator failure 不会被记录为 passed。
- pause 后当前 run 完成但不启动下一轮；resume 后继续。
- cancel 同时停止 supervisor run 和 candidate job。

### 9.5 Security tests

- candidate 文件 `../`、绝对路径、反斜线逃逸和 symlink。
- artifact 引用逃逸 outputs。
- subagent 输出中的 prompt injection 不得调用状态转换或扩大工具权限。
- env 不能覆盖 PATH、HOME、Node/Python runtime 和内部 token，除非显式白名单。
- scoped control token 不能访问其他 workspace/loop。
- workspace rename/delete 在活跃运行时返回冲突。
- 超大 stdout、stderr、candidate 和 artifact 不造成 OOM。

### 9.6 Frontend tests

- Research mode 提交后创建 draft，确认后进入 running。
- running loop 自动出现 candidate/agent/job 状态。
- 页面刷新、路由切换后恢复 active loop。
- pause/cancel 按钮语义和后端状态一致。
- needs-attention 显示可恢复操作。
- 新对话 Loading 修复、gap recovery 和普通聊天路径不回归。
- 非 Research 模式不会加载或创建 supervisor session。

### 9.7 Performance and soak tests

- 100 个 loop、每个 1000 条记录的列表和详情延迟。
- 10 个 workspace 并发 loop 的内存和文件句柄。
- 24 小时 serial loop soak，检查 observer、timer、child process 和 event listener 泄漏。
- 日志 compaction 前后状态重建结果完全一致。

### 9.8 Real-provider manual UAT

CI 使用 fake runner；真实模型只做受控 UAT：

1. 简单数值优化任务，目标可确定验证。
2. 候选第一次执行失败，确认 critic 能修正。
3. 人工 pause、reload、resume。
4. 执行中重启 Node，确认自动恢复。
5. 取消运行，确认无遗留 Pi/job 进程。
6. 检查 token/cost 与 pi-subagents lifecycle artifact 一致。

## 10. 合并门槛

必须满足：

- 自动完成 `plan -> propose -> execute -> evaluate -> next/stop`，前端不手工驱动阶段。
- 并发 execute/evaluate/cancel 测试稳定通过。
- 所有生命周期阶段重启测试通过。
- 正式指标来自执行过的 evaluator，不接受调用方自报 passed。
- pause/cancel 行为与 UI 文案一致。
- workspace rename 不会分裂 job/session/research 数据。
- 当前 conversation、gap recovery、新会话 Loading 和 session replacement 测试全部通过。
- 完整 typecheck、build、unit、integration 和定向 UAT 通过。

## 11. 已采用的默认假设与待确认项

默认假设：

- 第一版仅支持 serial loop 和单个活跃 candidate。
- subagent 使用当前用户配置的模型，但允许按角色覆盖，并受 token/cost budget 约束。
- candidate 代码属于用户确认后的 trusted local execution，但仍做路径、环境和资源限制。
- deterministic metrics 才能作为自动停止条件；LLM judge 默认只提供辅助评价。
- 有活跃 loop/job 时禁止 workspace rename，是 MVP 最安全的策略。

后续可能改变架构的待确认项：

- 是否需要第一版就并行生成多个 candidate；建议否。
- 是否允许用户自定义系统 Research agents；建议先只允许模型/思考级别覆盖，不允许覆盖核心控制 prompt。
- 是否允许 LLM judge 成为硬性通过条件；建议默认不允许，除非启用多评审和人工确认。
- 是否要求 supervisor 的过程实时显示在普通对话中；建议只显示摘要和状态，完整 transcript 放在 Research 页面。

## 12. 偏差处理规则

- 局部实现细节与计划不一致，但不改变数据模型、安全或用户语义时，选择保守实现并记录偏差。
- 如果 pi-subagents 的真实运行接口无法稳定提供 run ID、状态或结果恢复，应暂停实现并重新评估 supervisor adapter，不能退回内存 observer。
- 如果需要扩大 subagent 写权限、允许自报指标、改变执行信任模型或修改 workspace 数据迁移策略，必须先确认，不得由实现者自行决定。
- 源码和运行行为与本文假设冲突时，以实际源码/测试为准并更新方案。
