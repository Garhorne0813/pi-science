# Artifact 卡片（生成文件卡片）锚定问题 — 交接文档

面向：接手分析/修复的 agent
仓库：`Garhorne0813/pi-science`
分支/PR：`feat/scientific-activity-permission-artifacts`（**PR #107**，OPEN）
分析时本地 HEAD：`e790f0f1 Merge main into PR #107 and resolve conversation renderer conflict`
（本文所有行号基于该 commit，请以实际 checkout 为准）

> 阅读约定：**「已验证」= 有代码或运行时数据支撑；「假设」= 尚未验证，需要你确认。**
> 第 10 节列出了几个会让人得出错误结论的测量陷阱，**建议先读那一节**，我在这上面浪费了大量时间并两次发出错误结论。

---

## 1. 问题一句话

会话轮次执行后，**「生成文件卡片」（artifact strip）的归属轮次不可靠**：有时落在错误的轮次、有时整轮看不到、有时出现后消失。根因是**服务端发布 artifact 时使用的 turn 身份与轮次的真实身份不是同一套标识**，导致前端所有锚定手段退化。

---

## 2. 数据流（理解问题所必需）

```
pi runtime 原始事件
  └─ ConversationEventHub          为每个 agent_start 生成轮次身份并盖到事件上
       │  turn.turnOrdinal += 1
       │  turn.turnId = `turn-${sessionId}-${ordinal}-${randomUUID()}`   ← 会话内唯一、与轮次一致
       └─ SSE → 前端
  └─ NodeSessionService            独立监听同一批原始事件，自行维护一套轮次标识
       │  runtime.turnId = randomUUID()                                  ← 私有、与会话轮次无关
       │  runtime.turnOrdinal = nextTurnOrdinal(已持久化记录数 + 1)        ← “产出过文件的轮次数”
       └─ 在 agent_settled 时发布 turn.artifacts 事件（携带上面两个值）
            └─ 前端 foldLegacyEvent / attachTurnArtifacts 用它们“猜”卡片该插在哪一轮
```

关键点：**两条链路各自维护轮次身份，且没有对齐**。hub 的身份是权威的（其他所有事件都用它），artifact 事件用的是 NodeSessionService 自己那套。

前端消费侧：

```
foldLegacyEvent       实时流：把 turn.artifacts 折成一个 kind="artifact-summary" 的块，插到某个位置
attachTurnArtifacts   历史恢复：把持久化记录重新插回（重排/重建）
buildTurnPresentations 分组：按块上的 turnId / user 边界把块分成“轮次”
ConversationTurn       渲染：turn.artifacts.map(TurnArtifactStrip)
```

---

## 3. 三个用户可见症状

| # | 症状 | 当前状态 |
|---|---|---|
| S1 | 卡片出现在**错误的轮次**（实测：第 4 轮产出的卡片落在第 1 轮末尾） | 已验证，根因见 §4 §5；已有部分缓解（见 §8） |
| S2 | 卡片**出现后消失**（实测：出现约 80ms 后从 DOM 消失，之后整段会话都不再出现） | 已验证并已修（§8.2），需回归验证 |
| S3 | 运行中**提前显示「Completed」并来回闪烁** | 部分修复，残留约 5ms 的瞬时 settle（§7） |

另有一个**曾经被误报**的现象：某些时刻"整段会话看不到任何卡片"。**这是测量陷阱，不是产品缺陷** —— 见 §10.1。我据此发过两次错误结论，请勿重复。

---

## 4. 根因 A：artifact 的 `turnId` 是私有 UUID（核心）

### 4.1 发布侧

`apps/server/src/runtime/node/node-session-service.ts:873-883`

```ts
if (event.type === "agent_start") {
  runtime.turnId = randomUUID();                       // ← 私有 UUID，与会话轮次身份无关
  runtime.turnBaseline = snapshotWorkspace(cwd);
  runtime.turnAssistantPartId = undefined;
  runtime.turnOrdinal = await turnArtifactRepository
    .nextTurnOrdinal(runtime.cwd, sessionId)           // ← 见 §5
    .catch(() => (runtime.turnOrdinal ?? 0) + 1);
}
```

`.../node-session-service.ts:1240-1252`（`finishTurnArtifacts` 发布）

```ts
await this.eventHub.publish(runtime.cwd, sessionId, {
  type: "turn.artifacts",
  sessionId,
  turnId,            // ← 上面那个 randomUUID
  turnOrdinal,       // ← 产出过文件的轮次计数
  assistantMessageId,// ← 常态为 null（tool-only 轮次没有 assistant 消息锚点）
  endedAt,
  artifacts: items,
})
```

### 4.2 对比：hub 的权威身份

`apps/server/src/runtime/events/conversation-event-hub.ts:329-333`

```ts
function newConversationId(kind: "turn" | "run", sessionId: string, ordinal: number): string {
  return `${kind}-${sessionId}-${ordinal}-${randomUUID()}`;
}
```

`.../conversation-event-hub.ts:798-801`（每次 `agent_start`）

```ts
turn.turnOrdinal += 1;
turn.turnId = newConversationId("turn", sessionId, turn.turnOrdinal);
turn.runId  = newConversationId("run",  sessionId, turn.turnOrdinal);
```

### 4.3 实测数据（同一会话，`01a0ca11-...`，workspace `/Users/cyq/pi-science-workspaces/111`）

`permission.asked` 事件（hub 产出）——身份是**完整格式**：

```json
{ "turnId": "turn-01a0c9f1-...-6-a71a2dfd-2022-4113-a7a2-f02c7bd128c6",
  "runId":  "run-01a0c9f1-...-6-446b3aba-17d3-4437-83fb-1cf1ace7ee9c",
  "turnOrdinal": 6 }
```

`turn.artifacts` 事件（NodeSessionService 产出）——身份是**裸 UUID**：

```json
{ "type": "turn.artifacts",
  "turnId": "352d11c5-a5be-4a78-ab26-410e20b7dacb",
  "turnOrdinal": 5,
  "assistantMessageId": null,
  "endedAt": "2026-09-22T17:15:11.717Z",
  "artifacts": [ { "path": "growth.png", ... }, { "path": "stats.csv", ... } ] }
```

持久化记录（`<workspace>/.pi-science/turn-artifacts.jsonl`，字段同事件；`ended_at` 是**我这次新加的**，见 §8.1）：

```json
{ "turn_id": "352d11c5-a5be-4a78-ab26-410e20b7dacb",
  "session_id": "01a0ca11-...",
  "assistant_message_id": null,
  "turn_ordinal": 5,
  "ended_at": "2026-09-22T17:15:11.717Z",
  "artifacts": [ { "path": "growth.png", "kind": "image", ... } ] }
```

同一会话的 14 条记录，`turn_ordinal` = 1..14，而对应轮次在会话中的真实序号是 2..15 左右 —— **两套序号根本不同源**。

### 4.4 后果一：前端三条锚定路径全部失效

`frontend/src/lib/agent-runtime/event-fold.ts:637-672`（实时 fold 的锚定链，按顺序尝试）

```ts
let insertAt = -1;
if (assistantMessageId) insertAt = afterAssistantTurnEnd(blocks, assistantMessageId, index); // ← null，跳过
if (insertAt < 0) insertAt = afterIdentifiedTurn(blocks, turnId);                             // ← 表里有 turnId 的块，但格式不同，匹配不上
if (insertAt < 0 && endedAt) insertAt = afterTurnEndedAt(blocks, endedAt);                     // ← 时间锚点（我新加，见 §8.1）
if (insertAt < 0 && turnOrdinal > 0) insertAt = afterTurnEnd(blocks, turnOrdinal);             // ← 语义错，见 §5
const liveAnchor = index[foldState.lastAgentBlockId];
if (insertAt < 0 && liveAnchor !== undefined) insertAt = liveAnchor + 1;
if (insertAt < 0) insertAt = afterAgentBlock(blocks, insertedBefore + 1);                      // ← “第 n 张卡跟在第 n 个 agent 块后”
if (insertAt < 0) insertAt = blocks.length;
```

在 `endedAt` 锚点被加上之前，实际生效的是 `afterTurnEnd(blocks, turnOrdinal)`（把 ordinal 当**位置**解释：第 N 个 user 块划出的第 N 轮）。因为 ordinal 是"产出过文件的轮次数"，第 4 轮的卡片带 `ordinal=1`，就被插到**第 1 轮末尾**。实测复现：卡片渲染在第一轮问候语下方，而产出它的第三轮在 750px 之外。

### 4.5 后果二：main 新加的"归属路由"永远不生效

`frontend/src/lib/conversation/turn-presentation.ts:38-60`

```ts
const ownerByTurnId = new Map<string, string>();
for (const block of blocks) {
  const identity = "turnId" in block ? block.turnId : undefined;
  const key: string = block.kind === "user"
    ? `user:${block.id}`
    : block.kind === "artifact-summary" && identity
      ? ownerByTurnId.get(identity) ?? `turn:${identity}`   // ← 本意：把卡片路由回所属轮次
      : currentKey && byKey.get(currentKey)?.blocks.some((e) => e.kind === "user")
        ? currentKey
        : identity ? `turn:${identity}` : currentKey ?? `orphan:${block.id}`;
  ...
  if (identity && block.kind !== "artifact-summary") ownerByTurnId.set(identity, key);
}
```

`ownerByTurnId` 只由**非 artifact 块**填充，键是 hub 的 `turn-<session>-<n>-<uuid>`；artifact 块的 `identity` 是那个裸 UUID，`get()` 必然 undefined，于是回落到 `turn:${identity}` —— **卡片自成一个轮次分组**。

实测分组（`buildTurnPresentations` 在页面内直接调用，真实 thread 数据）：

```
0: tool.tool.tool.tool.tool.agent        artifacts=0
1: artifact-summary                      artifacts=1    ← 自成一组
2: user.tool.agent                       artifacts=0
3: artifact-summary                      artifacts=1    ← 自成一组
4: user.tool.agent                       artifacts=0
5: artifact-summary                      artifacts=1    ← 自成一组
6: user ×28 块                            artifacts=0
7: artifact-summary                      artifacts=1
8: user ×33 块                            artifacts=0
9: artifact-summary                      artifacts=1
```

可见后果：**会话导航栏条目数约为轮次数的两倍**（约 8 轮出现约 16 个条目），即每个卡片多出一条导航项。

这也解释了 §3 的 S3（闪烁）：分组键不稳 → 见 §7。

### 4.6 候选修复方向

**方向 1（推荐）：服务端对齐身份。**
让 `NodeSessionService` 发布 artifact 时使用 hub 的轮次身份，而不是自己 `randomUUID()`。
- 需要 hub 暴露轮次信封（如 `eventHub.currentTurn(cwd, sessionId)` 返回 `{ turnId, turnOrdinal, runId }`，或在 `publish()` 内对 `turn.artifacts` 自动盖上 `turnFields(turn)`）。
- **时序已核实**：`conversation-event-hub.ts:1056` 位于 `case "agent_settled"` 分支尾部 —— hub **先用 `turnFields(turn)` 发出 `session.idle`（携带真实 turnId/runId/outcome），随后才 `turn.turnId = null; turn.runId = null;`**。因此：
  - 若 `finishTurnArtifacts` 在 hub 处理完同一个 `agent_settled` 之后再向 hub 要身份，会拿到 null；
  - 可行做法是 hub **保留 last-settled 轮次信封**（不清空，或另存一份）并据此给 `turn.artifacts` 盖章；这与"先发 `session.idle` 再清空"的顺序天然吻合。
- 修好后 §4.4 的 `afterIdentifiedTurn` 与 §4.5 的 `ownerByTurnId` 两条路径会**同时**生效，卡片自然归属其轮次。
- 兼容性：旧记录里的 `turn_id` 仍是裸 UUID，仍依赖 `ended_at` 锚点；不要删掉现有锚定链。

**方向 2：只修 `turnOrdinal` 语义。** 让它等于会话轮次序号。
- 风险：`nextTurnOrdinal()` 的存在理由是"跨 runtime rebuild 保持计数"（见其注释）。改成会话轮次序号需要另一套持久化来源（hub 的 ordinal 是内存态，重启会重置）。单独改这一项会破坏"第 n 张卡跟第 n 轮"的兜底逻辑，**不建议单独做**。

**方向 3：前端不再依赖 turnId 路由，改由时间锚点全权负责。**
- 现状 `ended_at` 锚点已能正确定位（§8.1、§8.3），可在 `ownerByTurnId` 失效时用"该记录 `endedAt` 落在哪个 user 边界内"来分组。
- 但这只在卡片块本身已有 `endedAt` 时可行 —— 实时 fold 插入的块**没有把 `endedAt` 存到块上**（只用于算 insertAt）。若要按此方向做，需要在 `artifact-summary` 块上持久化 `endedAt`。这是一个小而自洽的改法，可作为方向 1 的替代。

---

## 5. 根因 B：`turnOrdinal` 是"产出过文件的轮次计数"

`apps/server/src/runtime/artifacts/turn-artifact-repository.ts:47-55`

```ts
async nextTurnOrdinal(cwd: string, sessionId: string): Promise<number> {
  const records = await this.forSession(cwd, sessionId);
  let max = 0;
  for (const record of records) {
    const ordinal = Number(record.turn_ordinal);
    if (Number.isInteger(ordinal) && ordinal > max) max = ordinal;
  }
  return max + 1;
}
```

语义 = `已持久化的 artifact 记录数 + 1`。实测：14 条记录 → `turn_ordinal` 1..14，而对应轮次的会话序号是另一个量级。

前端把它当位置用（`afterTurnEnd(blocks, ordinal)`，注释写明"1-based，按 user 块划界"），于是错位。§5 与 §4 是**同一处症状的两个侧面**：即使把 `turnId` 修对，只要 `turnOrdinal` 语义不变，任何回落到 ordinal 的路径仍会错位。**修复时两者需一起考虑。**

---

## 6. 根因 C：历史窗口不完整时，锚点失败 = 跳过（设计使然，但用户可感）

`frontend/src/lib/agent-runtime/event-fold.ts:1722-1730`（`attachTurnArtifacts`）

```ts
if (insertAt < 0 && !windowComplete) {
  // Partial history window: this record's turn has not loaded yet ...
  // so defer placement; a later attach (after the older page is prepended) anchors it correctly.
  continue;                                  // ← 直接跳过这张卡
}
```

`windowComplete` 来自 `!historyHasMore`。实测该会话 `/api/sessions/:id/artifacts` 返回 14 条记录，而 `/api/sessions/:id/messages` 只返回 50 条消息且 `has_more: true`；50 条里**只有 1 条 user message**（这个会话工具调用极多，一页只覆盖约一轮）。

后果：**只有"其轮次落在已加载窗口内"的记录能被锚定，其余被推迟**。在长会话里表现为"大部分卡片要往回翻才出现"。这是设计意图，但让"卡片在不在"取决于窗口状态，是 §10.1 测量陷阱的背景。

值得讨论的点：`continue` 之后**没有任何补偿机制**（下一次 attach 只在分页/重同步时发生）。是否应该在窗口补齐前保留一个"待放置"队列，或在轮到该轮时再试一次？——**这是开放问题，请分析。**

---

## 7. 相关但独立：运行中提前显示「Completed」并闪烁

### 7.1 机制（已验证）

`frontend/src/lib/conversation/turn-presentation.ts:75-85`

```ts
const identified = opts.lastTurnId ? ownerByTurnId.get(opts.lastTurnId) ?? `turn:${opts.lastTurnId}` : null;
const activeKey = identified && turns.some((t) => t.key === identified) ? identified : lastContentKey;
return turns.map((turn) => {
  const lifecycle = turn.key === activeKey ? opts.lastTurnLifecycle ?? "settled" : "settled";
  //                                     ↑ 非 activeKey 的分组一律 settled → 渲染成 “Completed”
  return buildTurnPresentation(turn.blocks, lifecycle);
});
```

即：**只要 active 身份没落在正在运行的那个分组上，运行中的轮次就会显示 "Completed"。**

探针实测（运行期间，`buildTurnPresentations` 每次调用的记录）：

```
10403ms  lastTurnId 有值   activeKey=turn:turn-01a0ca11   ← 真轮次
10415ms  lastTurnId=NULL   activeKey=turn:aaaf7dbe-c0e9   ← 切到 artifact 分组
10426ms  lastTurnId 有值   activeKey=turn:turn-01a0ca11
10426ms  lastTurnId=NULL   activeKey=turn:aaaf7dbe-c0e9   ← 持续 6 次采样
```

且整个运行期 `lastTurnId`（`thread.foldState.activeTurnId`）在"有值/缺失"间以约 8ms 周期横跳几十次。统计：8 次渲染的 active 组只含 `artifact-summary`。

### 7.2 已修（在 PR #107 中）

- `lastContentKey`：active 身份不落在"只含 artifact-summary 的分组"上（防 §4.5 的自成组抢走 active）。
- `identified` 找不到对应分组时回落到 `lastContentKey`（防历史重建后键不匹配导致**所有**分组都 settled）。

效果：修复前同一长任务从第 63 秒起持续出现；修复后前 84 秒 0 次。

### 7.3 残留（未修，需你分析）

修复后仍有 **1 次、约 5 毫秒**：

```
90613ms  busy=Y  "completed:Completed · … · No final answer"
90618ms  busy=Y  "running:Working…"
```

文本带 `No final answer`，说明**是 `turnLifecycle` 自身瞬时变成了 `settled`**，随后被流式事件重新激活 —— 与分组无关。

相关代码 `frontend/src/lib/agent-runtime/listener.ts`：

- settle 点：`agent_settled | session.idle | run.completed | run.cancelled` → `turnLifecycle: "settled"`（约 457-470 行）
- 重新激活：`agent_start | run.started`，以及任意 `activityEvent`（`text.updated` / `thinking.updated` / `tool.updated` / `plan.updated` / `item.*`）→ `turnLifecycle: "active"`（约 436-452 行）
- 抑制条件：`blocksLateEvents(lifecycle)` **只对 `aborted | failed` 返回 true**（`listener.ts:530`）→ **settled 之后任何流式事件都会把它翻回 active**，门槛极不对称
- 20 秒静默看门狗：`TURN_WATCHDOG_TICK_MS = 5_000`、`TURN_WATCHDOG_SILENCE_MS = 20_000`（约 80-81 行），探测到 `!runtimeWorking` 也会置 settled

开放问题：那 5ms 的 settle 究竟来自哪条路（某个 settle 事件，还是看门狗）？**建议在 settle 点与看门狗 tick 各插一个探针记录触发源**，一到两次运行即可确认。我没有继续，因为修它要改 settle 时机，风险高于收益。

**另需注意**：全局扫描 73 个会话事件日志，**没有任何一轮出现过第二次 `agent_start`**，也没有 `agent_settled` 事件（只有 `agent_end` + `session.idle`）。所以"settle→新 run"这条路不是主因。

---

## 8. 已经做过的修复（都在 PR #107 中，勿重复）

### 8.1 服务端：发布 `endedAt` + 实时 fold 使用时间锚点

- `apps/server/src/runtime/node/node-session-service.ts`：记录与事件共用同一个 `endedAt`（原先记录里有 `ended_at`、事件里没有）。
- `frontend/src/lib/agent-runtime/event-fold.ts:646-653`：实时 fold 在 turnId 锚点之后、ordinal 之前，插入 `afterTurnEndedAt(blocks, endedAt)`。
- 理由：`afterTurnEndedAt` 是**历史路径本来就在用**的锚点，源码注释称其为 "Primary fallback ... Independent of ordinals"。实时路径漏了它。
- 验证：离线用真实数据跑 `attachTurnArtifacts` → 正确附加 2 张；在线卡片落位正确（`GENERATED fact.txt` 在第 2 轮之后，`GENERATED fact2.txt` 在第 3 轮之后）。

### 8.2 「卡片出现 80ms 后消失」（S2）的根因与修复

`frontend/src/lib/agent-runtime/recovery.ts` 原实现：

```ts
function liveArtifactTurns(thread, sessionId) {
  return thread.blocks.flatMap((block) => block.kind === "artifact-summary" ? [{
    turn_id: block.turnId,
    assistant_message_id: block.assistantMessageId ?? null,
    turn_ordinal: block.turnOrdinal ?? null,
    ended_at: "",              // ← 从渲染块重建时硬编码空串
    artifacts: block.artifacts,
  }] : []);
}

function mergeArtifactTurns(persisted, live) {
  const byTurn = new Map(persisted.map((t) => [t.turn_id, t]));
  for (const turn of live) byTurn.set(turn.turn_id, turn);   // ← live 覆盖 persisted，真实 ended_at 被冲掉
  return [...byTurn.values()];
}
```

触发链（探针实测，`attachTurnArtifacts` 每次调用的记录）：

```
10238ms resync.fetched   {fetchedTurns:5, stripsInThread:4, working:false}
10239ms mergeWindow      {keepLiveExtras:false, resetProjection:true, stripsCurrent:4, stripsHistory:0}
                         ↑ 线程被换成“纯历史块”，live 卡片被丢弃，指望随后重建
10242ms resync.commit    {turns:6, mergedStrips:0, historyHasMore:true, windowComplete:false}
10242ms attach.record    turn=6c15f180 ended_at="" usable=false anchor=-1
10242ms attach.record    turn=1bbf4c4e ended_at="" usable=false anchor=-1
10242ms attach.record    turn=352d11c5 ended_at="" usable=false anchor=-1
10242ms attach.record    turn=e4935102 ended_at="" usable=false anchor=-1
10242ms attach.exit      changed=false stripsAfter=0        ← 一张都没重建
```

同几条记录在前三次 attach 里 `ended_at` 都有值并成功锚定（anchor=7/11/35）。差异来自 `turns` 被 `mergeArtifactTurns` 用 live 副本覆盖（`ended_at: ""`），三条锚点全废，再叠加 §6 的 `windowComplete:false` → 跳过 → 卡片永久消失。该路径只在 `metadataGeneration` 变化时走，即**每轮 artifact 发布的那一刻**，所以表现为"闪现 80ms 后消失"。

**修复**（`recovery.ts:212-229`）：

```ts
export function mergeArtifactTurns(persisted, live) {
  const byTurn = new Map(persisted.map((turn) => [turn.turn_id, turn]));
  for (const turn of live) {
    const previous = byTurn.get(turn.turn_id);
    // live 副本在 artifact 列表与 ordinal 上更新，但它由渲染块重建、没有轮次结束时间；
    // 直接覆盖会让记录失去唯一可用的锚点。
    byTurn.set(turn.turn_id, previous && !turn.ended_at ? { ...turn, ended_at: previous.ended_at } : turn);
  }
  return [...byTurn.values()];
}
```

验证：修复后重载，先前消失的两张卡自动恢复；新卡在 12 秒采样内持续稳定。

> 注意：`liveArtifactTurns` 里 `ended_at: ""` 仍然存在（只靠合并保留值兜住）。**更彻底的做法是让 live 块携带真实的 `endedAt`** —— 与 §4.6 方向 3 是同一件事。

### 8.3 用户消息重复（顺手修的，独立问题）

乐观块 id 是 `user-${Date.now()}`，与持久化 JSONL id 永不相等，只按 id 去重会保留两份。
**注意：main 合入后用协议级方案（`client_message_id`）取代了我的文本+时间戳启发式，我的测试也被改写成新语义** —— 这是正确的冲突解决，不要回退。

### 8.4 服务端：交互元数据空值

`conversation-event-hub.ts` 的 `stringify()` 原为 `JSON.stringify(value ?? "")`，对 `undefined` 产出**两个字面引号** `""`（truthy），导致权限卡片用 `""` 覆盖真实标题、并渲染空的 Scope/Effect 行。已改为 nullish 直接返回空串。

---

## 9. 如何复现与验证（可复用脚本）

仓库里已有一个可复用的页面内实时监视器：`frontend/scripts/uat-monitor.mjs`。

```js
const { MONITOR_SOURCE, READ_TRANSITIONS_SOURCE, formatTransitions } =
  await import("file:///<abs>/frontend/scripts/uat-monitor.mjs");
await tab.playwright.evaluate(MONITOR_SOURCE);   // 每次页面加载装一次
// …跑一轮任务…
nodeRepl.write(formatTransitions(await tab.playwright.evaluate(READ_TRANSITIONS_SOURCE)));
```

它按 React commit 采样（**不是定时器**）并只保留状态跃迁，能抓到 8ms 级变化。

**在页面内直接验证服务端↔前端契约**（非侵入、不改源码、不受虚拟化影响）——这是本次最有效的手段：

```js
// evaluate 里 import() 会被转译器改写，必须用注入 <script type="module"> 的方式
await tab.playwright.evaluate(() => {
  const s = document.createElement("script");
  s.type = "module";
  s.textContent = 'import * as mod from "/src/lib/agent-runtime/event-fold.ts"; ' +
                  'import { useRuntimeStore } from "/src/lib/agent-runtime/index.ts"; ' +
                  'globalThis.__mod = mod; globalThis.__store = useRuntimeStore;';
  document.head.appendChild(s);
});
// 然后即可：
//   __store.getState().thread.blocks …                     看 thread 里到底有没有 artifact-summary 块
//   __mod.attachTurnArtifacts(threadOf(realHistory), realRecords, { windowComplete:false })
//                                                          复现真实锚定结果
//   __mod.convertHistoryToBlocks(messages)                 构造真实历史块
```

`/api/sessions/:id/artifacts?cwd=` 与 `/api/sessions/:id/messages?cwd=` 可直接从页面内 `fetch`（vite 代理会注入内部 token）。

---

## 10. 测量陷阱（**强烈建议先读**）

### 10.1 会话有**两个**可滚动容器，`ScrollHeight` 相同

实测：

```
[data-testid="virtuoso-scroller"]  class="conversation-scroller overflow-y-auto"  sh=3176 ch=528 scrollTop=2648
div (无 testid)                                                                   sh=3176 ch=528 scrollTop=0
```

`document.querySelectorAll("div").find(d => d.scrollHeight > d.clientHeight + 50)` 命中的**不一定是 react-virtuoso 实际驱动的那个**。我据此做了"14 个滚动位置扫描"并得出"卡片完全不渲染"的结论 —— **完全错误**，因为渲染窗口从未变化。请用 `[data-testid="virtuoso-scroller"]`，或干脆不滚动（应用会自动跟随输出到末尾）。

### 10.2 轮次级虚拟化

`LiveSessionPage.tsx:369-372`：`firstItemIndex={virtualFirstItemIndex}`（默认 `100_000`，见 `hooks/useConversationScroll.ts:57`）、`data={turns}`、`computeItemKey={conversationTurnItemKey}`、`increaseViewportBy={{top:600,bottom:800}}`。
**只有渲染窗口内的轮次在 DOM 里**。因此"`aria-label="Generated files"` 计数为 0"不能直接推断为缺陷，必须先确认窗口位置。判定"渲染器是否收到了卡片"应查 `renderTurn` 的调用（§10.3 的做法），而不是查 DOM。

### 10.3 有效的探针（本次成功定位靠的就是这些）

- `ConversationBlocks.tsx` 的 `renderTurn` 入口：记录 `turn.id` / `turn.artifacts.length`。实测 86 次调用中 40 次带 artifacts → 渲染链路正常。
- `LiveSessionPage.tsx` 的 `turns` memo 后：记录分组签名。实测 10 组、含 5 个 artifact 组。
- `attachTurnArtifacts` 入口/每条记录/出口：记录 `turns` 条数、`windowComplete`、每条记录的 `ended_at`/`anchor` 与最终 `stripsAfter`。**这是定位 §8.2 的关键探针。**
- `buildTurnPresentations` 出口：记录 `lastTurnId`/`activeKey`/各组 key 与 blocks 种类。**这是定位 §7 的关键探针。**

### 10.4 输入环境特性（ZCode in-app browser）

- `requestAnimationFrame` **完全不触发**；页面定时器被节流到约 1 次/秒。
  → Playwright 的 `click()` 会因稳定性检查（依赖 rAF）超时而失败；请改用坐标点击 `tab.cua.click({x,y})`。`MutationObserver` 不受影响，是唯一可靠的高频观测手段。
- `evaluate` 中 `import()` 会被改写为 `importModule(` 并报 `ReferenceError` → 用 `<script type="module">` 注入（§9）。

---

## 11. 建议的优先级

1. **§4.6 方向 1**：服务端发布 hub 的轮次身份。这一项同时修好 §4.4（错误落位）与 §4.5（卡片自成分组 → 导航栏翻倍 + §7 闪烁的一大来源）。**建议先确认 hub 在 `agent_settled` 时是否还持有该轮次的 `turnId`**（`conversation-event-hub.ts` 约 1052 行有清空逻辑）。
2. **§6**：为"窗口不完整时被跳过的记录"补一个补偿路径（例如在窗口扩展后重试，或保留待放置队列）。
3. **§7.3**：用探针确认那 5ms settle 的来源，再决定是否收紧 settle 条件（当前 settled→active 的重新激活门槛极不对称）。
4. §4.6 方向 3 / §8.2 后续：把 `endedAt` 持久化到 `artifact-summary` 块上，让"归属"不再依赖不稳定的 `turnId`。可作为方向 1 的替代或补充。

---

## 12. 给分析者的开放问题

1. **hub 的 `turn.turnId` 在 `agent_settled` 之后是否仍可用？**
   已核实：`conversation-event-hub.ts:1031-1057` 的 `case "agent_settled"` 分支**先**发出带 `turnFields(turn)` 的 `session.idle`（含真实 `turnId`/`runId`/`outcome`），**后**才 `turn.turnId = null; turn.runId = null`。
   所以直接"事后去问 hub"会拿到 null。**待你评估**：是在 hub 保留一份 last-settled 信封并给 `turn.artifacts` 盖章，还是让 `NodeSessionService` 在 `agent_start` 时就从 hub 缓存身份（后者要求 hub 暴露一个读取接口）。两者都需考虑 runtime rebuild / 会话恢复时的一致性。
2. `turnOrdinal` 的双重语义（会话轮次序号 vs 产物记录计数）应统一到哪一套？如果统一到 hub，重启后 hub 计数重置的问题如何解决（`newConversationId` 的注释称"ordinal 仅用于诊断"）？
3. §6 的 `continue` 是否应该改为"暂存并在下次 attach 重试"？有无更简单的等价方案（例如把未锚定的记录挂在窗口末尾并标记 provisional）？
4. §7.3 的 5ms settle，是事件驱动还是看门狗驱动？若是看门狗，20s 静默 + `!runtimeWorking` 的组合在长工具调用/SSE 抖动下是否会误判？
5. §10.1 的双滚动容器是否本身就是缺陷（一个未被卸载的旧实例）？如果是，可能同时解释用户提出的"闪烁"里的一部分。

---

## 13. 当前仓库状态

- 分支 `feat/scientific-activity-permission-artifacts`（PR #107），HEAD `e790f0f1`（main 已合入并解冲突）。
- 本次会话新增 7 个提交并已推送（`02b1f9a3` … `a00d589c`），CI 曾全绿；之后 main 合入的 `e790f0f1` 未再跑本地全量验证以外的 CI 确认。
- 本地验证：前端 133 文件 / 1149 测试、服务端 95 文件 / 863 测试、`typecheck` + `lint` 均通过（`e790f0f1` 上）。
- 工作区仅有一处未提交改动：`frontend/scripts/uat-conversation.mjs`（分析前即存在，非本次改动）。另有大量未跟踪的 `docs/`、`.pi/` 文件。


## 14. 2026-09-23 复核与修复

代码核对确认 §4/§5 的身份和序号不一致，以及旧记录在 presentation 中自成一组的问题。§8.2 的合并兜底已存在，本次继续补齐 live block 的结束时间。

需修正的判断：
- §5 的精确算法是最大持久化 ordinal + 1，不严格等于记录数 + 1；不能作为用户轮次位置。
- §6 “没有任何补偿机制”不成立：`session-actions.ts` 的分页加载会重新获取 artifact 记录并调用 `attachTurnArtifacts`。未加载轮次应等历史窗口扩展，不能临时挂到当前轮次。
- §7.3 的 5ms settle 来源，以及双滚动容器是否异常，仍无足够证据；本次没有修改生命周期或滚动逻辑，也未重复验证历史运行时测量。

本次修复：
- hub 将本次规范化事件的轮次身份传给 observer，NodeSessionService 在 agent_start 缓存该身份；持久化与 SSE 使用同一个 turnId / turnOrdinal，无需在 settled 清空后再查询。
- 新格式 hub ordinal 仅作诊断，前端无法通过 ID/消息/时间定位时，不将它当作历史位置。旧格式保留兼容兜底。
- 旧 artifact ID 无法匹配内容时，保留 fold/attach 已确定的轮次位置，避免卡片额外生成导航分组。
- live、历史与 recovery 均保留 endedAt；结束时间及助手锚点在异步文件扫描前捕获。
- 时间锚点支持有用户边界但无助手文本的纯工具轮次。

回归覆盖：observer 与 SSE 身份一致、无产物轮次及 hub 重建后的序号重置与 ID 唯一性、artifact 持久化身份、旧记录分组、纯工具轮次恢复、hub ordinal 不作位置兜底。
