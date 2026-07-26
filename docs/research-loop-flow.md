# 研究循环（Research Loop）执行流程

## 概述

研究循环是 Pi Science 中用于自动化科学实验迭代的核心机制。它采用 **"提案-执行-评估"（Propose-Execute-Evaluate）** 的闭环模式，由 LLM 驱动候选方案生成，在隔离的沙箱中执行实验，并通过可注册的评估器（Evaluator）对结果进行量化评估。系统自动追踪帕累托前沿（Pareto Frontier），在满足停止条件或预算耗尽时终止。

## 核心概念

### 1. Research Loop（研究循环）

一个研究循环代表一次完整的实验优化过程，包含以下关键要素：

| 要素 | 说明 |
|------|------|
| **objective** | 研究目标（自然语言描述，最长 4000 字符） |
| **evaluator** | 评估器引用（`evaluator_id` + `version` + `digest`），定义成功标准 |
| **budget** | 资源预算：最大候选数、最大运行时长、最大 token 数、最大费用 |
| **stop_conditions** | 停止条件：目标指标阈值、耐心值（patience）、最小改进量 |
| **mode** | 当前 MVP 仅支持 `serial`（串行模式，`max_parallel=1`） |

### 2. Candidate（候选方案）

每个候选方案是一个自包含的可执行实验：

- **files**：一组文件（1-100 个），包含实验代码/脚本
- **entrypoint**：入口文件（默认 `solve.sh`），由 `bash` 执行
- **approach_summary**：LLM 生成的方法摘要
- **idempotency_key**：幂等键，防止重复提交相同方案
- **parent_candidate_ids / inspiration_id**：谱系追溯

### 3. Evaluator（评估器）

评估器是注册在系统中的度量标准定义：

```typescript
{
  evaluator_id: string;    // 唯一标识
  version: number;         // 版本号
  digest: string;          // 内容摘要（sha256）
  status: "approved";      // 必须是 approved 状态
  metrics: [{             // 评估指标列表（至少 1 个）
    name: string;          // 指标名称
    direction: "maximize" | "minimize";
    weight: number;
  }];
  hard_checks: string[];  // 硬性检查项（如 "artifact_verified"）
}
```

### 4. Experience（经验记录）

每个候选方案的完整生命周期快照，由事件溯源（Event Sourcing）重放构建：

- `status`：`proposed` → `running` → `succeeded`/`failed` → `passed`/`failed`（评估后）
- `solution`：方案文件路径和摘要
- `execution`：执行信息（job_id, run_id, 工作目录, 输出目录, stdout/stderr 摘录）
- `evaluation`：评估结果（指标值、硬性检查、结论）
- `artifacts`：产出物引用

### 5. Pareto Frontier（帕累托前沿）

在所有通过评估（`evaluation_status === "passed"`）的候选方案中，通过多目标支配关系（dominance）筛选出的非支配解集。一个方案 A 支配方案 B 当且仅当 A 在所有指标上不劣于 B 且至少在某一指标上严格优于 B。

---

## 状态机

```
                  ┌──────────┐
                  │  draft   │
                  └────┬─────┘
                       │ preflight 通过
                  ┌────▼─────┐
                  │  ready   │
                  └────┬─────┘
                       │ start
                  ┌────▼─────┐
          resume  │ running  │  pause
        ┌────────┤           ├─────────┐
        │        └────┬──┬───┘         │
   ┌────▼───┐         │  │        ┌────▼───┐
   │ paused │         │  │        │completed│ (终端)
   └────┬───┘         │  │        └─────────┘
        │             │  │
        └─────────────┘  │
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          failed    cancelled    (终端)
          (终端)    (终端)
```

状态转换规则：

| 当前状态 | 允许转换到 |
|----------|-----------|
| `draft` | `cancelled` |
| `configuring` | `cancelled` |
| `ready` | `running`, `cancelled` |
| `running` | `paused`, `completed`, `failed`, `cancelled` |
| `paused` | `running`, `cancelled` |
| `completed` | （无） |
| `failed` | （无） |
| `cancelled` | （无） |

---

## 完整执行流程

### 阶段 0：准备阶段

```
用户输入研究目标
       │
       ▼
┌─────────────────────────┐
│ POST /research-loop-    │  自然语言 → 结构化草稿
│       intents           │  返回 draft + missing_fields
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 注册 Evaluator          │  POST /evaluators
│ (如尚未注册)            │  定义评估指标和硬性检查
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ POST /research-loops    │  创建 Loop
│                         │  状态: draft
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ PATCH /research-loops   │  可选的配置调整
│       /:id              │  仅 draft/configuring/paused 可编辑
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ POST /:id/preflight     │  起飞前检查:
│                         │  • evaluator 存在且 approved
│                         │  • digest 匹配
│                         │  • 至少 1 个 metric
│                         │  • mode=serial, max_parallel=1
│                         │  通过 → 状态: ready
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ POST /:id/start         │  启动循环
│                         │  状态: ready → running
└─────────────────────────┘
```

### 阶段 1：提案（Propose）— 由 LLM 驱动

```
POST /research-loops/:loop_id/candidates
    │
    ▼
┌────────────────────────────────────────────┐
│ 1. 校验 loop 状态 === "running"            │
│ 2. 幂等键检查（如提供 idempotency_key）    │
│ 3. 预算检查:                               │
│    • 候选数 < max_candidates               │
│    • 运行时长 < max_wall_seconds           │
│    • token 数 < max_model_tokens           │
│    • 费用 < max_cost_usd                   │
│ 4. 串行模式下检查是否有活跃候选            │
│ 5. 快照候选文件（文件锁保护）:             │
│    • 校验所有路径安全（无 .. 逃逸）        │
│    • 写入临时目录 → 原子 rename            │
│    • 计算 sha256 摘要                      │
│    • 设置文件只读权限                      │
│    • 写入 solution.json 清单               │
│ 6. 追加 candidate.proposed 事件记录        │
└────────────────────────────────────────────┘
```

**候选文件存储结构：**
```
.pi-science/
  solutions/
    <candidate_id>/
      solution.json     # 清单文件（candidate_id, digest, entrypoint 等）
      solve.sh          # 入口脚本（权限 0o555）
      ...               # 其他文件（权限 0o444）
```

### 阶段 2：执行（Execute）

```
POST /research-loops/:loop_id/candidates/:candidate_id/execute
    │
    ▼
┌────────────────────────────────────────────┐
│ 1. 校验 loop 状态 === "running"            │
│ 2. 校验候选存在且未被重复执行              │
│ 3. 校验方案路径在 solutions/ 根目录内      │
│ 4. 创建运行目录:                           │
│    runs/<run_id>/                          │
│      work/        ← 复制候选文件（可写）    │
│      outputs/     ← 输出目录               │
│ 5. 注入环境变量:                           │
│    PI_SCIENCE_OUTPUT_DIR=<outputs_dir>     │
│    PI_SCIENCE_RUN_ID=<run_id>              │
│    PI_SCIENCE_CANDIDATE_ID=<candidate_id>  │
│ 6. 提交 Job: bash <entrypoint>            │
│    surface: "research-loop"               │
│    timeout: min(max_wall_seconds, 86400)   │
│ 7. 追加 candidate.execution_started 事件   │
│ 8. 启动后台观察者 (observeExecution):      │
│    • 每 50ms 轮询 Job 状态                 │
│    • Job 终止 → 追加                        │
│      candidate.execution_finished 事件     │
│      (含 return_code, stdout/stderr 摘录)  │
└────────────────────────────────────────────┘
```

**Job 状态**（由 `JobCoordinator` 管理）：`succeeded` | `failed` | `cancelled` | `timed_out`

### 阶段 3：评估（Evaluate）

```
POST /research-loops/:loop_id/candidates/:candidate_id/evaluate
    │
    ▼
┌────────────────────────────────────────────┐
│ 1. 校验 evaluator 存在                     │
│ 2. 校验候选执行成功 (status === succeeded) │
│ 3. 校验候选未被重复评估                    │
│ 4. 指标校验:                               │
│    • 所有声明指标均已提供且方向正确         │
│    • 无未声明指标                           │
│ 5. 硬性检查校验:                           │
│    • 所有 hard_checks 均有结果              │
│    • artifact_verified=passed 时至少 1 个   │
│      artifact 且文件存在                    │
│ 6. 计算 evaluation_status:                 │
│    • 所有 hard_checks 通过 → "passed"       │
│    • 任一未通过 → "failed"                  │
│ 7. 追加 candidate.evaluated 事件           │
│ 8. 检查停止条件:                           │
│    • 目标指标达成 → completed (reason:      │
│      target_metrics_reached)               │
│    • 预算耗尽 → completed (reason:         │
│      candidate_budget_exhausted /          │
│      wall_time_budget_exhausted /          │
│      model_token_budget_exhausted /        │
│      cost_budget_exhausted)                │
└────────────────────────────────────────────┘
```

### 阶段 4：迭代

在串行模式下，LLM 协调器循环执行 提案 → 执行 → 评估 三步：

```
         ┌──────────────────────────────────┐
         │  LLM 读取当前 frontier 和         │
         │  历史 experiences                 │
         └───────────────┬──────────────────┘
                         │
         ┌───────────────▼──────────────────┐
         │  LLM 生成新的 Candidate 方案      │
         │  (基于已有结果改进)               │
         └───────────────┬──────────────────┘
                         │
         ┌───────────────▼──────────────────┐
         │  POST /candidates (propose)      │
         └───────────────┬──────────────────┘
                         │
         ┌───────────────▼──────────────────┐
         │  POST /candidates/:id/execute    │
         │  (bash 执行候选脚本)             │
         └───────────────┬──────────────────┘
                         │
         ┌───────────────▼──────────────────┐
         │  等待 Job 完成 (observer 轮询)    │
         └───────────────┬──────────────────┘
                         │
         ┌───────────────▼──────────────────┐
         │  POST /candidates/:id/evaluate   │
         │  (LLM 评估结果)                  │
         └───────────────┬──────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ 停止条件满足？       │
              └──────┬──────────────┘
                 N   │   Y
              ◄──────┘   ──────►  completed
              (继续迭代)           (结束)
```

---

## 数据持久化

### 事件溯源（Event Sourcing）

所有状态变更以追加（append-only）JSONL 格式记录在：

```
<workspace>/.pi-science/research-records.jsonl
```

**记录类型清单：**

| record_type | 含义 | 关键 payload |
|-------------|------|-------------|
| `evaluator.registered` | 评估器注册 | evaluator_id, version, metrics, hard_checks |
| `loop.created` | 循环创建 | title, objective, budget, stop_conditions |
| `loop.updated` | 循环配置更新 | 变更的字段 |
| `loop.state_changed` | 循环状态变更 | status, stop_reason |
| `candidate.proposed` | 候选提案 | candidate_id, approach_summary, solution |
| `candidate.execution_started` | 执行开始 | job_id, run_id, work_dir, outputs_dir |
| `candidate.execution_finished` | 执行结束 | status, return_code, stdout_excerpt, stderr_excerpt |
| `candidate.evaluated` | 评估完成 | metrics, hard_checks, evaluation_status |

### 文件系统结构

```
.pi-science/
  solutions/                      # 候选方案快照（只读）
    <candidate_id>/
      solution.json
      solve.sh
      ...
  runs/                           # 执行运行时目录
    <run_id>/
      work/                       # 可写的工作副本
      outputs/                    # 脚本输出（$PI_SCIENCE_OUTPUT_DIR）
  research-records.jsonl          # 事件日志
  .research-mutation-lock         # 提案阶段的文件锁
```

### 状态重建

`listLoops()` 和 `experiences()` 通过重放 `research-records.jsonl` 重建当前状态：
- Loop：合并 `loop.created` + `loop.updated` + `loop.state_changed`
- Experience：按 candidate_id 分组，串联 `proposed → started → finished → evaluated`

---

## API 端点汇总

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/project-memory/research-loop-intents` | 从自然语言生成循环草稿 |
| `GET` | `/api/project-memory/research-loops` | 列出所有研究循环 |
| `POST` | `/api/project-memory/research-loops` | 创建研究循环 |
| `GET` | `/api/project-memory/research-loops/:id` | 获取循环详情（含 experiences 和 frontier） |
| `PATCH` | `/api/project-memory/research-loops/:id` | 更新循环配置 |
| `POST` | `/api/project-memory/research-loops/:id/preflight` | 起飞前校验 |
| `POST` | `/api/project-memory/research-loops/:id/:action` | 生命周期操作（start/pause/resume/cancel/complete） |
| `POST` | `/api/project-memory/research-loops/:id/candidates` | 提交候选方案 |
| `POST` | `/api/project-memory/research-loops/:id/candidates/:cid/execute` | 执行候选方案 |
| `POST` | `/api/project-memory/research-loops/:id/candidates/:cid/evaluate` | 评估候选结果 |
| `GET` | `/api/project-memory/research-loops/:id/experiences` | 获取候选经验列表 |
| `GET` | `/api/project-memory/research-loops/:id/frontier` | 获取帕累托前沿 |
| `POST` | `/api/project-memory/evaluators` | 注册评估器 |
| `GET` | `/api/project-memory/evaluators` | 列出评估器 |
| `GET` | `/api/project-memory/evaluators/:id/versions/:v` | 获取特定评估器版本 |

所有端点需要通过 `?cwd=<workspace_path>` 指定工作空间。

---

## 前端集成

### 组件层次

```
ResearchPage (完整研究页面)
  ├── 侧边栏: Loop 列表
  ├── Loop 详情区
  │   ├── 基本信息卡（状态、候选数、模式、评估器）
  │   ├── Candidate 列表
  │   └── Pareto Frontier 展示
  └── 操作按钮 (Pause/Resume/Cancel)

ResearchLoopControls (对话内嵌控件)
  ├── ResearchModePicker      # 模式选择器
  │   research_loop | optimize | compare | evaluate | reproduce
  ├── ResearchLoopDraftCard   # 创建确认卡片
  │   表单: title, objective, metric, direction, maxCandidates, maxWallSeconds
  └── ResearchLoopStatusCard  # 运行状态卡片
      状态显示 + 操作按钮 + 最新指标
```

### 轮询机制

当前端检测到 loop 状态为 `running` 或 `paused` 时，会以 **2 秒间隔**轮询 `/research-loops/:id` 端点，更新 experiences 和 frontier 展示。
