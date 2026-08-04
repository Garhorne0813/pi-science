````
# 刷新后问卷表单消失与 "Working…" 卡死问题修复

## 问题描述

问卷表单(AskUserQuestion)弹出后刷新页面,出现两个叠加症状:

1. **表单不恢复**——`questionnaire.asked` 事件不会重新投递,`pendingQuestionnaire`/`pendingInteraction` 保持 null,表单消失
2. **"Working…" 永久显示**——代理进程还在等待用户回答(报告 `is_streaming: true`),但没有任何事件能清理 `working` 状态,转圈永不消失

## 根因分析

### 症状 1:SSE 无游标连接不重放历史事件

前端 SSE 游标(`lastEventIds` Map)是**内存态**,页面刷新即丢失:

- 刷新后重连无 `lastEventId` 参数 → 服务端 `sse-routes.ts` 以 `Boolean(lastEventId)=false` 调用 `conversationEventHub.subscribe(..., replay=false)`
- `conversation-event-hub.ts` 只有 `replay=true` 才执行 `eventStore.readAfter()` 重放;`replay=false` 时**只收未来事件**

```ts
// sse-routes.ts:118-123
unsubscribe = await conversationEventHub.subscribe(
  cwd, sessionId, lastEventId,
  (record) => enqueue(serializeSseEvent(record)),
  Boolean(lastEventId),   // 刷新后无游标 → false → 不重放
);
```

因此刷新后 `questionnaire.asked`(问卷数据)和 `question.asked`(交互标记)都不会重新投递,前端无法重建表单。

### 症状 2:working 状态无人清理

- **快照报告忙碌**:`getSessionState` → `is_streaming: true`。pi-orbit 的 `_isAgentRunActive` 在整个 agent 循环(含暂停等待用户输入)期间恒为 true,等待回答时不会归位
- **终端事件不发**:`agent_settled`/`session.idle` 只在用户回答、工具结束、回合真正完成后才发出;等待回答期间**没有任何事件**清理 working
- **reconcile 不运行**:`reconcilePromptAfterLateStream` 只在 `sendPrompt` 且流未打开时启动,页面刷新不触发
- **UI 渲染条件**:`LiveSessionPage.tsx` 的 "Working…" 显示条件是 `working && !pendingInteraction` —— 表单存在时不显示转圈,表单丢失后转圈永远可见

### 事件链路(问卷的完整投递路径)

问卷由 `ask_user_question` 工具触发,服务端事件 hub 发出**两个**事件:

```
tool_execution_start (tool=ask_user_question)  → questionnaire.asked(含完整 questions)
adapter 的 ctx.ui.input(前缀 pi-science-questionnaire-v1:)  → question.asked(questionnaire: true)
```

前端 listener 分别设置 `pendingQuestionnaire` 和 `pendingInteraction`,两者齐备才渲染 `QuestionnairePrompt`。

## 修复方法

### 1. 服务端:SSE 订阅时补投未决交互(`conversation-event-hub.ts`)

**设计**:在内存中跟踪"代理正在等待回答的交互"(per 会话流),每次新订阅者连接时主动补投——不依赖游标,不读磁盘事件日志(现有测试断言无游标订阅不调用 `readAfter`,且服务端重启时代理进程同样重启,内存态足够)。

新增字段:

```ts
private readonly pendingInteractions = new Map<string, SseEventRecord[]>();
```

`publish()` 中维护(append 之后):

```ts
const type = String(payload.type ?? "");
if (type === "questionnaire.asked") {
  this.pendingInteractions.set(key, [record]);
} else if (type === "question.asked" && payload.questionnaire === true) {
  // Keep the questionnaire.asked + matching question.asked pair.
  this.pendingInteractions.set(key, [questionnaireRecord, record]);
} else if (type === "question.asked" || type === "permission.asked") {
  // Only the current generic interaction is recoverable.
  this.pendingInteractions.set(key, [record]);
} else if (type === "questionnaire.finished" || type === "agent_settled" || type === "session.idle") {
  this.pendingInteractions.delete(key);
}
```

The interaction route calls `resolvePendingInteraction(cwd, sessionId, requestId)` after a successful browser response, removing the resolved request (and its questionnaire pair) before the next refresh.

`subscribe()` 中补投(replay 投递之后、`subscriber.ready = true` 之前;现有 `delivered` 集合天然去重):

```ts
const pendingInteraction = this.pendingInteractions.get(key);
if (pendingInteraction) {
  for (const record of pendingInteraction) {
    if (!send(record)) return unsubscribe;
  }
}
```

### 2. 前端:working 语义修正(3 个文件)

**语义变更**:`working = true` 从"runtime 自认为忙"改为"代理正在主动处理、用户需要等待"。代理暂停等待用户回答时不算工作状态。

| 文件 | 改动 | 场景 |
|---|---|---|
| `frontend/src/lib/agent-runtime/recovery.ts` | `reconcilePromptAfterLateStream`只在匹配的问卷交互已到达时清 `working` | 防止 questionnaire.asked 与 question.asked 之间过早启用输入 |
| `frontend/src/lib/agent-runtime/session-actions.ts` | `connect`:`nextState.working = runtimeBusy && !awaitingUserInput` | REST 快照先于 SSE 补投到达的时序竞态 |
| `frontend/src/lib/agent-runtime/listener.ts` | `questionnaire.finished`按 toolCallId 清理；`agent_settled`/`session.idle`清理 pending | 避免已完成交互在刷新后残留 |

### 修复后的刷新链路

```
刷新 → SSE 无游标重连
  → 服务端补投 questionnaire.asked + question.asked
  → 前端 listener 恢复 pendingQuestionnaire/pendingInteraction → 表单渲染
  → working 语义对齐(REST 快照不覆盖)
  → UI 条件 working && !pendingInteraction = false → 无转圈
```

## 改动文件

| 文件 | 改动 |
|---|---|
| `apps/server/src/runtime/events/conversation-event-hub.ts` | `pendingInteractions` 跟踪、按 requestId 解析、subscribe 补投 |
| `apps/server/src/runtime/events/conversation-event-hub.test.ts` | 覆盖未决补投、只保留最新交互、响应清理、已解决不补投 |
| `frontend/src/lib/agent-runtime/recovery.ts` | `awaitingUserInput` 检查 |
| `frontend/src/lib/agent-runtime/session-actions.ts` | `connect` working 计算 |
| `frontend/src/lib/agent-runtime/listener.ts` | 匹配完成事件与 settled 清理 pending |

前端对补投事件零特殊处理——复用 listener 既有路径,重放与实时事件同构。

## 验证

```bash
cd apps/server && npx vitest run src/runtime/events/conversation-event-hub.test.ts   # 13/13
cd apps/server && npx vitest run src/runtime/node/node-session-service.test.ts       # 21/21
pnpm typecheck    # ✅
```

手动验证:问卷弹出 → 刷新 → 表单恢复且无 "Working…";提交后代理继续;已提交完的会话刷新不弹旧表单。

## 附:相关排查(独立问题)

> 相关文档:表单 UI 重设计见 [questionnaire-prompt-redesign.md](questionnaire-prompt-redesign.md);滚动导致表单状态清空(React 重挂)见 [scroll-remount-form-state-loss.md](scroll-remount-form-state-loss.md)。

验证过程中发现 `ask_user_question` 工具完全缺失(代理只有内置工具),根因独立于本修复:`createSessionRequestSchema` 把缺失的 config 默认成 `{ skills: [], extensions: [] }`(`packages/contracts/src/index.ts`),而 `create` 合并 `{ ...effectiveConfig(), ...body.config }` 让空数组覆盖了运行时检测的扩展列表,导致代理进程启动时无 `-e` 参数。修复见 `apps/server/src/runtime/node/node-session-service.ts` 的 create 合并逻辑(空数组不覆盖检测结果),并添加了对应回归测试。

````
