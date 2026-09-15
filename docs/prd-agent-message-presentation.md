# PRD：Agent 中间叙述与最终回答的呈现语义

> 状态：Implemented in PR #97  
> 适用范围：conversation presentation / progress activity UI  
> 目标分支：`feat/progress-visual-settings`  
> 调研日期：2026-09-15

## 1. 背景

PR #97 为 pi-science 增加了可配置的 progress visuals，并同时扩展了 turn presentation，使一个 turn 内的 `thinking`、tool activity 与 agent narration 能按时间顺序展示。

现有实现已经具备两个重要概念：

- `presentationRole: "intermediate" | "final"`：表示一段 assistant 文本在当前 turn 中的展示语义；
- `TurnLifecycle`：表示整个 turn 当前是 live、settled、failed、aborted 等状态。

但是 settled turn 的 UI 策略与这些语义不一致：tool/thinking 会被放入折叠的 process trace，而 intermediate agent narration 会继续在主聊天流里永久展开。因此复杂任务会出现大量“我先检查…… / 接下来…… / 已发现……”的过程性文本堆在最终回答上方。

这会造成三个问题：

1. **主回答层级被稀释**：用户难以快速识别最终答案。
2. **折叠策略不完整**：tool/thinking 被折叠，但同属 process history 的 commentary 被保留在外部。
3. **协议语义与 UI 不一致**：`presentationRole="intermediate"` 已经表达“非最终回答”，但 settled UI 仍把它当普通聊天正文。

本 PRD 定义 message semantics、generation stop semantics 与 turn lifecycle 的职责边界，并给出 PR #97 的 UI 修复要求。

---

## 2. 产品目标

### 2.1 核心目标

在不牺牲 live progress 可见性的前提下，让一个 turn 完成后只在主聊天流中保留最终回答：

- **live turn**：intermediate narration、thinking、tools 按时间顺序展开，用户能看到 agent 正在做什么；
- **terminal turn**：intermediate narration、thinking、tools 统一折叠为 process trace；
- **final answer**：始终作为主聊天正文独立展示，不进入 process trace；
- **无 final answer**：不得把 commentary 自动提升成最终回答，应明确提示 “No final answer returned”，过程内容仍可从折叠区恢复。

### 2.2 设计原则

1. **展示语义优先于生成终止原因**：UI 应消费 provider-independent 的 `presentationRole`，而不是直接解释 provider 的 `stopReason` / `finishReason`。
2. **运行中透明，结束后简洁**：live 时展示完整过程；terminal 后默认压缩过程历史。
3. **最终答案唯一**：一个 turn 的主消息区域最多展示一个 final/provisional answer。
4. **过程可恢复**：折叠不是丢弃；用户展开后应看到 intermediate narration、thinking、tools 的完整时间序列。
5. **legacy 可兼容**：缺少显式 phase 的历史数据继续使用结构推断，但不能因此改变新协议的语义边界。

---

## 3. 同类产品调研

### 3.1 OpenAI Codex

Codex protocol 显式定义 `MessagePhase`，将 assistant 文本区分为：

- `Commentary`：mid-turn preamble / progress narration；
- `FinalAnswer`：当前 turn 的 terminal answer。

这与 pi-science 的 `presentationRole: "intermediate" | "final"` 是同一层级的抽象。

参考：

- Codex `MessagePhase`：https://github.com/openai/codex/blob/fc269b66adc37f3c855df222ad80b02733355c46/codex-rs/protocol/src/models.rs
- Codex issue #30190：当 exec/SDK 丢掉 phase 后，下游 UI 无法可靠区分 commentary 和 final answer，只能错误展示 preamble 或做启发式猜测：https://github.com/openai/codex/issues/30190

**结论**：phase / presentation role 是 presentation protocol 的必要字段，不能用结构猜测或 finish reason 完全替代。

### 3.2 Anthropic Claude

Anthropic Messages API 的 `stop_reason` 明确表示**为什么本次模型生成停止**。常见值包括：

- `end_turn`
- `tool_use`
- `max_tokens`
- `pause_turn`
- `refusal`
- `model_context_window_exceeded`

官方建议用 `tool_use` 驱动 tool loop，用 `max_tokens` / `pause_turn` / `refusal` 等做各自的运行控制或恢复处理。

参考：

- https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works

**结论**：`stop_reason` 是 generation/agent-loop control signal。`end_turn` 可以是“可能形成最终输出”的强信号，但它不等价于 UI 的 final-answer semantic role；例如 truncation/refusal/pause 都是“生成结束”但不是正常 final answer。

### 3.3 Google Gemini

Gemini `Candidate.finishReason` 的官方定义是 “the reason why the model stopped generating tokens”，包括 `STOP`、`MAX_TOKENS`、`SAFETY`、`MALFORMED_FUNCTION_CALL` 等。

参考：

- https://ai.google.dev/api/generate-content

**结论**：finish reason 同样属于 generation 层，不应直接映射为 conversation presentation role。

### 3.4 Vercel AI SDK

AI SDK 在每个 step 上保留 `finishReason`，同时保留 `steps[]`、tool calls/results 和 agent-loop 的 stop condition。`finishReason` 描述某一步为什么结束，而最终 agent 行为由多 step loop 决定。

参考：

- https://v4.ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
- https://v4.ai-sdk.dev/docs/foundations/agents

**结论**：step termination 与 final user-visible answer 是不同层次。

---

## 4. 语义模型

pi-science 应明确保持三层独立语义。

### 4.1 Presentation role：这段 assistant 文本是什么

```ts
type PresentationRole =
  | "intermediate"
  | "final";
```

语义：

| Role | 含义 | Live UI | Terminal UI |
|---|---|---|---|
| `intermediate` | preamble、progress narration、阶段性发现、工具前后说明 | 展开 | 折叠到 process trace |
| `final` | 用户应当作为本 turn 主答案阅读的文本 | streaming 时可作为 provisional/final 展示 | 主聊天正文独立展示 |

`presentationRole` 是 conversation presentation 的 authoritative semantic signal。

### 4.2 Generation stop reason：为什么一次生成停止

未来 provider adapter 可归一化：

```ts
type GenerationStopReason =
  | "stop"
  | "tool_use"
  | "length"
  | "pause"
  | "refusal"
  | "content_filter"
  | "error"
  | "other"
  | "unknown";
```

职责：

- 控制 agent loop 是否继续；
- 标记截断、暂停、拒绝、错误；
- 在 provider 没有显式 phase 时，为 presentation classification 提供辅助信号；
- 用于诊断和 telemetry。

**不得**由 frontend 直接使用 `stopReason === "stop"` 推导 final answer。

### 4.3 Turn lifecycle：整个任务进行到哪一步

继续使用现有：

```ts
type TurnLifecycle =
  | "queued"
  | "active"
  | "waiting"
  | "recovering"
  | "stopping"
  | "settled"
  | "aborted"
  | "failed";
```

职责：

- 决定 activity stream 是否保持展开；
- 决定 terminal trace 是否折叠；
- 决定错误/中止状态文案。

---

## 5. 分类优先级

当前 PR #97 已有 `presentationRole` 与 `classificationSource`，应继续沿用。

推荐分类顺序：

1. **显式 phase / presentationRole**
   - `final_answer` → `final`
   - `commentary` → `intermediate`
2. **未来 normalized stop reason + turn state**
   - `tool_use` / `pause` → 强烈倾向 `intermediate`
   - natural stop + terminal turn + no pending tool → 可作为 `final` fallback
   - length/refusal/error/content-filter → 不得自动标记为正常 final
3. **legacy structural inference**
   - 使用当前 `latestUnsupersededAgent` / trailing visible tool 规则
   - 只用于历史兼容，不作为新协议首选真值

推荐扩展 `classificationSource`（后续独立实现）：

```ts
type ClassificationSource =
  | "explicit"
  | "provider_inferred"
  | "legacy_inferred"
  | "unknown";
```

---

## 6. UI 状态机

### 6.1 Live turn

示例：

```text
User

commentary A
thinking
tool A
commentary B
tool B
Working · 8.4s
```

要求：

- commentary/intermediate narration 可见；
- thinking 可见；
- tool lines 可见；
- chronology 不被打乱；
- provisional answer 仍可在 tool 尚未 supersede 时显示；
- progress status 保持在当前活动底部。

### 6.2 Settled turn，有 final answer

默认：

```text
User

▶ Completed · 12.4s

Final answer...
```

展开：

```text
User

▼ Completed · 12.4s
  commentary A
  thinking
  tool A
  commentary B
  tool B

Final answer...
```

要求：

- intermediate narration 默认不可见；
- tool/thinking 默认不可见；
- final answer 立即可见；
- 展开 process trace 后恢复完整过程；
- final answer 不得被复制到 trace 中。

### 6.3 Settled turn，无 final answer

默认：

```text
▶ Completed · No final answer returned
```

展开：

```text
▼ Completed · No final answer returned
  commentary A
  tool A
  commentary B
```

要求：

- 不把最后一条 commentary 冒充 final answer；
- process history 仍可查看。

### 6.4 Aborted / failed

intermediate narration 与 tool/thinking 同样属于 process history，terminal 后默认折叠；summary 使用现有 `Stopped` / `Encountered a problem` 状态文案。

---

## 7. 本次 PR #97 实现范围

### 7.1 必做

1. `AgentActivity`
   - terminal lifecycle 下，把 intermediate narration、thinking、tools 统一作为 `traceBlocks`；
   - 明确排除 `presentationRole === "final"`；
   - 删除 settled 状态下 narration 的无条件外部渲染；
   - `No final answer returned` 继续工作，并成为可展开 summary 的一部分。

2. `ConversationTurn`
   - 维持现有职责：`finalAgent ?? provisionalAgent` 作为主聊天消息；
   - 不改变 final answer 的 Markdown/code/table/KaTeX 渲染路径。

3. Tests
   - 单元测试覆盖 intermediate narration 默认折叠、展开后恢复；
   - 单元测试覆盖 explicit final 不进入 AgentActivity trace；
   - E2E 覆盖 live narration 可见、session idle 后折叠、final answer 唯一显示；
   - history recovery 与 live path 保持一致。

4. 文档
   - 本 PRD 随代码提交，作为后续 stopReason normalization 的协议基线。

### 7.2 本次不做

- 不新增 provider-specific `stopReason` wire field；
- 不修改 server/runtime provider adapters；
- 不把 `presentationRole` 替换成 `stopReason`；
- 不改变 legacy history 的 structural inference 算法；
- 不改变 progress pattern/settings 本身；
- 不改变 final Markdown 渲染器。

原因：当前用户问题属于 presentation policy bug。引入 provider-level stop-reason normalization 会扩大 PR #97 的协议和 runtime 风险面，应单独实现并测试。

---

## 8. 代码设计

### 8.1 `AgentActivity`

旧逻辑：

```ts
traceBlocks = activities.filter(block => block.kind !== "agent")
narrationBlocks = activities.filter(block => block.kind === "agent")
```

结果：

- thinking/tool → fold
- intermediate agent → always visible

新逻辑：

```ts
traceBlocks = activities.filter(
  block => block.kind !== "agent"
    || block.presentationRole !== "final"
)
```

terminal 时：

- intermediate/unknown agent narration → fold
- thinking → fold
- tool → fold
- explicit final → excluded from AgentActivity

生产路径中 `ConversationTurn` 已经从 `activityBlocks` 排除了当前 `visibleAgent`，因此 final answer 仍由 `AgentMessage` 唯一渲染。

### 8.2 `noAnswer`

条件：

```ts
lifecycle === "settled"
&& !hasExplicitFinal
&& traceBlocks.some(block => block.kind === "agent")
```

如果只有 intermediate narration，没有 final，则 summary 显示 missing-final 状态；展开可查看 narration。

### 8.3 Defensive behavior

即使测试或未来调用者错误地把 `presentationRole="final"` 的 block 传给 `AgentActivity`，组件也不应在 process trace 中重复渲染它。

---

## 9. 数据流

```text
runtime/provider events
        │
        ▼
event-fold
  phase/presentationRole
        │
        ▼
TurnPresentation
  ├─ activityBlocks
  │    ├─ intermediate agent
  │    ├─ thinking
  │    └─ tools
  │
  └─ visibleAgent
       └─ final/provisional
        │
        ▼
ConversationTurn
  ├─ AgentActivity(activityBlocks)
  │    live: open
  │    terminal: folded
  │
  └─ AgentMessage(visibleAgent)
       final answer in main flow
```

---

## 10. 验收标准

1. 一个包含 2 条 commentary + 3 个 tools + 1 条 final answer 的 turn，在运行过程中 commentary/tool 均可见。
2. 同一个 turn 在 `session.idle` / settled 后：
   - commentary 默认不可见；
   - tools/thinking 默认不可见；
   - final answer 可见且只出现一次；
   - 显示一个 Completed summary。
3. 点击 Completed summary 后：
   - commentary 恢复；
   - thinking 恢复；
   - execution tools 恢复；
   - final answer 不在 trace 中重复出现。
4. history reload 后行为与 live-settled path 一致。
5. todo/plan-control 仍不泄漏到普通 execution trace。
6. settled turn 只有 intermediate narration、没有 final 时：
   - 默认显示 `No final answer returned`；
   - commentary 不在主聊天流冒充答案；
   - 展开 summary 可查看 commentary。
7. aborted/failed terminal turn 的 process narration 默认折叠。
8. live turn 行为不回归：streaming narration 仍然立即可见。

---

## 11. 测试计划

### Unit：`AgentActivity.test.tsx`

覆盖：

- live narration 与 reasoning；
- terminal reasoning folding；
- terminal intermediate narration folding；
- explicit final exclusion；
- no-final summary；
- expand 后 chronology 恢复；
- tool detail 展开不受影响。

### Integration：`ConversationTurn.activity.test.tsx`

覆盖真实链路：

```text
SSE event
→ event-fold
→ buildTurnPresentations
→ ConversationTurn
→ AgentActivity + AgentMessage
```

检查：

- live → settled transition；
- final answer 唯一性；
- commentary 的折叠/恢复；
- history hydration parity；
- todo state recovery。

### Regression

PR #97 原有 frontend test suite 与 build 应继续通过。

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 模型/provider 不提供 phase | 某些历史文本只能结构推断 | 保留 legacy inference；不删除 `classificationSource` |
| 最后一条 commentary 被误判 final | 主回答错误 | final selection 与 activity folding 分层；显式 intermediate 永不提升 |
| final 被重复放进 trace | UI 重复 | AgentActivity defensive filter 排除 explicit final |
| 用户认为过程“消失” | 可解释性下降 | process summary 始终可展开，内容不删除 |
| failed/aborted 调试信息难找 | 调试成本上升 | trace 可展开，错误 summary 保留 |
| 未来引入 stopReason 后语义混乱 | provider coupling | stopReason 只进入 runtime/classifier，不直接驱动 frontend presentation |

---

## 13. 后续工作：stopReason normalization

建议单独 PR：

1. provider adapters 抽取原始 stop/finish reason；
2. contracts 增加 provider-independent `generationStopReason`；
3. history/event wire 保留该字段用于诊断；
4. classifier 在缺少 explicit phase 时使用 stop reason 作为二级信号；
5. 增加 truncation/refusal/pause 的 terminal notice UX；
6. telemetry 比较 explicit phase、stop reason inference、legacy structural inference 的一致率。

成功标准不是“用 stopReason 替代 phase”，而是：

> explicit presentation semantics 优先；stop reason 提供运行控制和 fallback evidence；legacy structural inference 最后兜底。

---

## 14. 决策记录

本 PRD 的最终决策：

- **保留 `presentationRole`**；
- **不以 `stopReason` 直接定义 final/intermediate**；
- **live intermediate narration 展开**；
- **terminal intermediate narration + thinking + tools 一起折叠**；
- **final answer 独立于 activity trace**；
- **stopReason normalization 延后到独立协议/runtime PR**。

该决策与 Codex 的 commentary/final-answer phase 模型一致，也与 Anthropic、Gemini、AI SDK 将 stop/finish reason 定义为 generation termination metadata 的做法保持职责分离。
