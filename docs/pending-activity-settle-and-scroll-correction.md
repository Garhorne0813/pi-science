# 待办问题交接：运行中瞬时 settle（提前显示「Completed」）+ 滚动容器误判的更正

面向：接手分析/修复的 agent
仓库：`Garhorne0813/pi-science`　分支：`pr-107`（PR #107）
本文基于提交 `8d3fa0ef`（"align artifact cards with conversation turn identity"）之后的代码

> 阅读约定：**「已验证」= 有代码或运行时数据支撑；「假设」= 尚未验证。**
> 上一份文档 `docs/artifact-card-anchor-issue-handoff.md` 里的 §7.3 与 §10.1 是两个待办项。
> **本文 Part 2 更正了 §10.1 —— 那不成立，是我的测量误判，不是产品缺陷。**
> Part 1（§7.3）是真实的、仍未修复的问题。

---

## Part 1　运行中瞬时 settle → 提前显示「Completed」

### 1.1 现象（已验证，逐 commit 采样抓到）

在一个耗时约 98 秒的四步任务里，用页面内 `MutationObserver` 监视器（每 React commit 采样，见 §3.1）记录到**唯一一次**异常：

```
68160ms → 90595ms   busy=Y  行状态=running   文本 "Working…"
90613ms             busy=Y  行状态=completed 文本 "Completed · … · No final answer"   ← 异常，仅 1 次采样
90618ms → 94615ms   busy=Y  行状态=running   文本 "Working…"
97444ms             busy=n  行状态=completed 文本 "Completed · …"                     ← 真正的收尾
```

要点：
- **只持续约 5 毫秒**，且**只有逐 commit 采样能看到**（截图和人工观察都不可能捕捉）。
- 文本带 `No final answer` → 说明此刻 `turnLifecycle` 被判为 `settled`，且该轮有 narration 但没有 explicit final（`AgentActivity.tsx` 的 `noAnswer` 分支）。
- 发生在**任务中途**（90.6s / 总共 ~98s），不是在收尾附近。

修复前的同类可观测性更高：同一长任务在修复分组问题之前，从第 63 秒起**持续**出现（累计 5 次，更早一轮是 41/46 次采样）。分组问题修好后只剩这 1 次 5ms 窗口。

### 1.2 「Completed」的渲染条件（已验证）

`frontend/src/components/conversation/AgentActivity.tsx`

```ts
if (isLiveLifecycle(lifecycle)) { /* 渲染“进行中”：Working / 等待输入 / 等待批准 / Stopping */ }
/* 否则进入 settled 分支，summaryLabel = t("conversation.activity.completed") = "Completed" */
```

`frontend/src/lib/conversation/turn-presentation.ts:128-130`

```ts
export function isLiveLifecycle(lifecycle: TurnLifecycle): boolean {
  return lifecycle === "queued" || lifecycle === "active" || lifecycle === "waiting"
      || lifecycle === "recovering" || lifecycle === "stopping";
}
// 注意：settled 不在其中
```

**结论：只要 `turnLifecycle === "settled"`，界面就必然渲染 "Completed"。** 因此那 5ms 意味着 `turnLifecycle` 真的被置成了 `settled`，然后又被翻回 `active`。

### 1.3 置为 settled 的两条路径

**路径 A：事件驱动**　`frontend/src/lib/agent-runtime/listener.ts:467-478`

```ts
} else if (event.type === "agent_settled" || event.type === "session.idle"
        || event.type === "run.completed" || event.type === "run.cancelled") {
  bumpConversationGeneration();
  if (!blocksLateEvents(state.turnLifecycle)) {
    useRuntimeStore.setState({ working: false, turnLifecycle: successful ? "settled" : "failed", ... });
```

**路径 B：看门狗**　`listener.ts:80-81, 104-162`

```ts
const TURN_WATCHDOG_TICK_MS = 5_000;
const TURN_WATCHDOG_SILENCE_MS = 20_000;

async function runTurnWatchdogTick() {
  if (!client || !current.working || ... || turnLifecycle === "waiting" || "stopping") { disarm(); return; }
  const silentFor = Date.now() - lastTurnEventAt;
  if (silentFor < TURN_WATCHDOG_SILENCE_MS) { turnWatchdogReconnected = false; return; }
  if (!turnWatchdogReconnected) { turnWatchdogReconnected = true; client.reconnect(...); return; }   // 先重连一次
  const runtimeState = await client.getSessionState(sessionId, cwd);
  ...
  const runtimeWorking = runtimeState.is_streaming || runtimeState.is_compacting || runtimeState.pending_message_count > 0;
  if (!runtimeWorking) {
    // 置 working:false / turnLifecycle:"settled" / 触发 resyncCompletedHistory / disarm()
  }
}
```

关键细节（已验证）：
- `lastTurnEventAt` 由 `noteTurnEvent()` 刷新，而 `listener.ts:210` 对**除 `connection.*` 之外的所有事件**都刷新它。→ 触发条件是"**连续 20 秒一个事件都没有**（连接类除外）"。
- 首次越过 20 秒阈值的那一 tick **只做重连**（`turnWatchdogReconnected = true` 后 return），真正探测并 settle 发生在**再下一 tick**，即最少 20 秒、最多约 30 秒静默后。
- 若期间有 `pendingInteraction`，走 `waiting` 分支而不是 settled（已处理权限等待场景）。

### 1.4 翻回 active 的门槛极不对称（已验证）

`listener.ts:439-452`

```ts
if (runStarted && !knownTerminalRun && state.turnLifecycle !== "stopping") {   // agent_start / run.started
  useRuntimeStore.setState({ working: true, turnLifecycle: "active", ... });
} else if (activityEvent) {   // text.updated / thinking.updated / tool.updated / plan.updated / item.*
  if (!blocksLateEvents(state.turnLifecycle) && ... ) {
    useRuntimeStore.setState({ working: true, turnLifecycle: "active", ... });
  }
}
```

`listener.ts:530`

```ts
function blocksLateEvents(lifecycle: string): boolean { return lifecycle === "aborted" || lifecycle === "failed"; }
```

**`settled` 不在抑制名单里 → settle 之后任何一条流式事件都会把状态翻回 `active`。** 所以只要出现一次假 settle，就**必然**能看到 "Completed → 进行中" 的跳变。

### 1.5 已排除与未排除的触发源

**已验证排除**：
- **不是"第二个 run"**：扫描 73 个会话的事件日志，**没有任何一轮出现过第二次 `agent_start`**，同一 `turnId` 下的 `agent_start` 计数全部为 1。
- **没有 `agent_settled` 事件**：这些日志里只有 `agent_end` + `session.idle`（各每轮一次，都在轮次真正的结尾）。

**因此路径 A 在观测窗口内是干净的**，那 5ms 更可能来自**路径 B（看门狗）**。**这是假设，不是结论** —— 尚未证实。

看门狗为何会误判？需要满足"20 秒无任何非连接类事件 + 运行时报告未在流式/压缩/有待处理消息"。可能的长静默来源（均为待验证假设）：
- 长时间工具执行期间没有输出/心跳；
- SSE 连接抖动（重连期间事件断流）；
- `getSessionState` 与 run 状态之间的竞态（例如两个 run 的间隙里 `is_streaming` 瞬时为 false）。

### 1.6 建议的下一步：先插探针定位触发源

**不要在没有证据的前提下改 settle 逻辑。** 建议在下面几处各记一条带来源标签的日志（沿用上一份文档 §9 的页面内探针手法，记录到 `globalThis.__settleProbe`）：

| 位置 | 记录内容 |
|---|---|
| `listener.ts:467` 的 settle 分支 | `{ source: "event", type: event.type, runId, turnId, lifecycleBefore, workingBefore }` |
| `listener.ts:152-161` 看门狗 settle | `{ source: "watchdog", silentFor, runtimeState: { is_streaming, is_compacting, pending_message_count } }` |
| `listener.ts:443-450` reactivation | `{ source: "reactivate", via: "runStarted" \| event.type, runId }` |
| `noteTurnEvent()` | `{ source: "note", type }`（可选，用于事后重建静默窗口） |

配合现有的实时监视器（§3.1）在同一时间轴上对照，**一到两次长任务运行即可确认** 90613ms 那类窗口来自哪条路，以及当时 `runtimeState` 的三个字段究竟是什么值。

### 1.7 修复方向（待选定，均有取舍）

**方向 1：给看门狗加确认，不要单次探测就 settle。**
例如要求连续两次（间隔一个 tick 即 5s）都判定 `!runtimeWorking` 才 settle；或探测后延迟数秒复检。
代价：真正卡死的轮次会晚 5 秒左右才被判结束——对用户是"多转 5 秒"，通常可接受。

**方向 2：把 settle 当作"待确认"状态，直到有终局事件背书。**
看门狗只置一个 `settledProvisional`（渲染上仍视为进行中，或渲染成"仍在等待"），只有路径 A 的终局事件才真正落成 `settled`。
代价：需要新增状态并处理它与 `isLiveLifecycle` 的关系；真正"无终局事件"的场景（运行时被杀）会一直显示进行中——这点需要产品决策。

**方向 3：把 reactivation 的门槛与 settle 对称化。**
当前 `settled` 被任意 `activityEvent` 翻回 active。可改为：**只有 run 作用域的信号才能推翻 settle**（新的 `run.started`/`agent_start`，或带新 `runId` 的事件），零散的迟到 delta 不足以为凭。
- 已有先例：`listener.ts` 里的 `knownTerminalRun`（`state.thread.foldState?.terminalRunIds.includes(event.runId)`）就是按 runId 做终局判定的。
- 代价：若某轮确实在 settle 后继续产出（例如晚到的 tool 结果），界面会停留在旧的 settled 态直到新 run 出现——需要确认服务端在这类场景下是否一定会发 `agent_start`。

**方向 4：只延迟 UI 呈现。** settle 后加一个几百毫秒的防抖再渲染 "Completed"，若期间被翻回 active 则用户完全看不到闪动。
代价：治标；且会让真正的收尾延迟呈现。

> 个人倾向：**先做 §1.6 的探针确认触发源，再在方向 1 与方向 3 之间选**。方向 1 改动最小、语义最清楚；方向 3 更根本但影响面大。

### 1.8 已知的相关不对称（供参考，不一定要改）

- `compaction.updated` 结束时会置 `active`（`listener.ts:455-461`），注释明确说"压缩结束不等于 run 结束"——说明这个方向上的判断已被专门处理过，可作为参考风格。
- `TURN_WATCHDOG_SILENCE_MS = 20_000` 与 `TURN_WATCHDOG_TICK_MS = 5_000` 都是硬编码常量，无自适应。

---

## Part 2　更正：「双滚动容器」不成立

### 2.1 我在上一份文档里写了什么

> §10.1「会话有**两个**可滚动容器，`ScrollHeight` 相同」——并把它列为可能的产品缺陷（§12 开放问题 5：「一个未被卸载的旧实例」）。

**这是错的。** 实测该会话只有一个真正的滚动容器。特此更正，避免后续 agent 在错误方向上花时间。

### 2.2 实测的 DOM 结构（已在浏览器中核对）

```
[data-testid="virtuoso-scroller"].conversation-scroller.overflow-y-auto
    scrollHeight=3433  clientHeight=528  overflow-y: auto   scrollTop=2905   ← 唯一真正的滚动容器
  └─ div (无 testid、className="")                             ← 内层内容包装器
        scrollHeight=3433  clientHeight=528  overflow-y: visible
      ├─ div
      ├─ div[data-testid="virtuoso-item-list"]   （内容高度 3433）
      └─ div
```

- `document.querySelectorAll('[data-testid="virtuoso-scroller"]').length === 1`
- `document.querySelectorAll('[data-testid="virtuoso-item-list"]').length === 1`
- 那个内层包装器的父元素**就是**真正的滚动容器；它自己是 `overflow-y: visible`，**不会滚动**（`scrollTop` 恒为 0）。
- 它之所以落进我的"可滚动"筛选条件，是因为我的启发式是 `scrollHeight > clientHeight + 50 && clientHeight > 200`——一个**内容溢出的非滚动包装器同样满足**这个条件。

### 2.3 那为什么我当时的"滚动扫描"看起来没生效？

除了上面的误判，还有一个**独立的测量 bug**：我在**同一次 `evaluate` 里先设置 `scrollTop`、紧接着读取 DOM**。react-virtuoso 是在滚动事件之后的另一个任务里才重新计算并渲染窗口的，所以那次读取拿到的是**滚动前**的状态。于是多个位置报告了完全相同的分组/条目 —— 我据此得出"渲染窗口从未变化"，进而误判为"卡片完全不渲染"。

**正确做法**：设置滚动与读取 DOM 分成**两次 `evaluate`**（中间留几百毫秒），或干脆不滚动——应用自身会把视图跟随到最新输出，最新的轮次本来就在渲染窗口内。

### 2.4 结论

- **不是产品缺陷**，无需修复；`ConversationNavRail`、虚拟列表、`useConversationScroll` 都无需改动。
- 上一份文档 §10.2（轮次级虚拟化）与 §10.3（有效探针）仍然成立且有用；§10.1 请以上文为准。

---

## 3. 复现与观测手段（沿用，已验证有效）

### 3.1 页面内实时监视器

仓库内已有 `frontend/scripts/uat-monitor.mjs`：

```js
const { MONITOR_SOURCE, READ_TRANSITIONS_SOURCE, formatTransitions } =
  await import("file:///<abs>/frontend/scripts/uat-monitor.mjs");
await tab.playwright.evaluate(MONITOR_SOURCE);        // 每次页面加载装一次
// …跑任务…
const log = await tab.playwright.evaluate(READ_TRANSITIONS_SOURCE);
console.log(formatTransitions(log));                  // 或 nodeRepl.write(...)
```

它由 `MutationObserver` 驱动（**不是定时器**），按签名去重并归一化计时器文本，因此能保留 5ms 级的真实跃迁而不被 `Working 0.1s / 0.2s` 刷屏。判定"当前轮次那一行"时取**最后一个非 `closed:` 的 `[data-state]` 行**（前面的行属于更早的轮次，直接扫全部会误报）。

### 3.2 输入环境特性（ZCode in-app browser，实测）

- `requestAnimationFrame` **完全不触发**；页面定时器被节流到约 1 次/秒。
  → Playwright 的 `click()` 会因稳定性检查（依赖 rAF）超时而失败，改用坐标点击 `tab.cua.click({x, y})`。
  → 也因此**不要用 `setInterval` 采样**，要用 MutationObserver。
- `evaluate` 中的动态 `import()` 会被改写为 `importModule(` 并抛 `ReferenceError`；需要模块时用注入 `<script type="module">` 的方式（见上一份文档 §9）。
- 发送提示后要**验证发送真的生效**（`Stop generation` 按钮出现 / 用户消息计数增加）。我曾因点击未生效而把"没有回复、没有产物"误判为产品缺陷——输入框里文字还在就是没发出去。

---

## 4. 现在的仓库状态

- 分支 `pr-107`，HEAD `8d3fa0ef`；**该提交尚未推送到远端分支**（`origin/feat/scientific-activity-permission-artifacts` 仍停在 `e790f0f1`，本地领先 1 个提交）。
- 本地验证（`8d3fa0ef` 上）：`typecheck` + `lint` 通过；前端 133 文件 / 1151 测试、服务端 95 文件 / 864 测试通过。服务端 `notebook-service.test.ts` 的 jupyter 用例在并行负载下偶发失败，单独重跑即过（与分析内容无关）。
- 工作区未提交改动：`docs/artifact-card-anchor-issue-handoff.md`（对 §10.1 的更正）、`frontend/scripts/uat-conversation.mjs`（分析前即存在）。
- `apps/server/src/runtime/artifacts/turn-artifact-repository.ts` 的 `nextTurnOrdinal()` 在 `8d3fa0ef` 之后已无生产调用方（仅其自身测试），可清理。


## 5. 复核结论与本次修复

### 5.1 证据边界与更正

- §1.2 的逆向推断不成立：`No final answer` 证明的是传给该 `AgentActivity` 行的 lifecycle 为 settled，而非全局 `turnLifecycle` 必然经历了 settled。`buildTurnPresentations` 会将非 active 分组标为 settled；DOM 上的 Stop 按钮也不能替代同一时刻的 store 快照。
- §1.3 并非全部写入路径：`recovery.ts` 等恢复/异步路径同样可以置 settled。事件日志中没有中途终局事件，不能排除这些路径，更不能单凭日志将旧的 5ms 样本归因到看门狗。
- §1.4 需要限定：带已知终局 runId 的活动事件已由 `knownTerminalRun` 阻止重激活，并非任何活动都会重激活。无终局身份的恢复场景仍需允许真实活动恢复 active。
- Part 2 的滚动容器更正与代码结构一致。本次无需修改滚动实现；也没有重新做页面测量来声称复现当时的 DOM 样本。

### 5.2 已确定、可重复复现的缺陷

看门狗在 `await client.getSessionState()` 前后只检查 working、sessionId 和 cwd。以下时序在本地测试中稳定复现：

1. SSE 静默，20 秒时重连，25 秒时发起 REST 状态查询并暂缓响应。
2. REST 等待期间，收到新的文本事件或新轮次的 agent_start。
3. 返回较旧的 idle 响应。旧实现仍将当前轮次设为 settled，并触发文件刷新/历史重同步。

同会话重新连接、用户发起停止等状态变化也缺少过期校验。另一个确定问题是查询超过 5 秒时，每次 tick 都再次请求：测试中 15 秒内累计 4 个并发探测，响应可能相互覆盖。

这些是已复现的实际竞态；不能据此声称已证明它们就是旧 5ms 样本的唯一来源。

### 5.3 采用的修复

采用异步结果有效性校验，而非额外延迟 Completed 或禁止 settled 后恢复：

- 记录探测时的 connection/activity/localMutation 版本、事件计数和生命周期；结果返回后，任何一项变化都使其失效。
- 事件计数覆盖元数据和同毫秒事件，避免仅比较时间戳漏掉更新；收到活动后重新开始静默重连周期。
- 同一个看门狗只保留一个进行中的探测。停用或更换客户端时使探测失效；旧请求不能清理新看门狗的探测状态。
- 仍保留静默且状态未变化时的 idle 收尾，以及探测失败后的重试，不增加额外五秒等待。

回归测试使用假时钟、可控 REST 响应和真实 store/SSE listener，并订阅 store 捕获中间状态，确保不是“先 settled 再改回 active”。覆盖文本、新轮次、元数据、权限等待、连接/活动/本地操作版本、慢请求重叠、旧探测与新轮次、请求失败重试。

### 5.4 验证结果

- 前端全量：134 个测试文件、1,161 项测试通过（含新增 10 项看门狗回归）。
- 前端 typecheck、lint 与 `git diff --check` 通过。
- 本次未启动真实模型长任务，历史 5ms 样本的精确触发源仍未还原；上述缺陷通过可控时序测试验证。
