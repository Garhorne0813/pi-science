# 待办问题交接：轮次被切成「碎片分组」，凭空多出一行「Completed」并把卡片带走

面向：接手分析/修复的 agent
仓库：`Garhorne0813/pi-science`　分支：`pr-107`（PR #107）
本文基于 `51a4e3a6`（"fix: ignore stale live-turn watchdog responses"）之后的代码

> 阅读约定：**「已验证」= 有代码或运行时数据支撑；「推断」= 与代码/数据一致但未直接取证；「未验证」= 尚不清楚。**
> 这不是之前修过的任何一项。请勿与下列已修问题混淆：
> - 卡片落位错乱（`turnId` 私有 UUID）→ 已由 `8d3fa0ef` 修复
> - 看门狗过期响应导致瞬时 settle → 已由 `51a4e3a6` 修复
> 本次是**分组切分**导致的独立缺陷。

---

## 1. 现象（用户可见，已实测）

会话 `01a0cef4-f24f-7382-9000-aa460bd8bd1a`（workspace `/Users/cyq/pi-science-workspaces/111`）在**只有一条用户消息**的情况下，界面呈现：

```
y= 32   [无用户消息的容器]  "Completed · 17s   GENERATED · 2   pelican-riding-bicycle.preview.png…"
y=196   [真正的轮次容器]    "生成一个鹈鹕骑自行车的svg · 11:49 PM · Completed · 3m02s · 已生成并渲染验证…"
```

即：**会话最上方凭空多出一行 "Completed · 17s"，且这一轮产出的文件卡片（GENERATED · 2）挂在了这行上**，真正的轮次在它下面。使用者会读成"这轮提前结束了"，而且找不到卡片归属。

同一会话的 `DOM` 里能同时看到两行已完成活动行：

```
completed: Completed · 17s      ← 碎片行（时长是它自己那两个块的时间跨度）
completed: Completed · 3m02s    ← 真正的轮次
closed:    deepseek-v4.1-flash Max
```

统计行显示 `1 turns · 10 steps`，与"两行已完成"互相矛盾——这正是分组的破绽。

---

## 2. 根因（已验证）

`buildTurnPresentations`（`frontend/src/lib/conversation/turn-presentation.ts:34-61`）把这一轮切成了 **2 个分组**：

```
group 0: key=turn:turn-01a0cef4-…-2-8f69d507-…   kinds="thinking.artifact-summary"   user=null                                      activityBlocks=1
group 1: key=user:8de37226                        kinds="user.thinking.tool.…"        user="生成一个鹈鹕骑自行车的svg"                 activityBlocks=19
```

### 2.1 触发它的块数组（实测快照）

| i | kind | id（截断） | turnId | client_message_id | artifacts |
|---|---|---|---|---|---|
| 0 | thinking | `thinking-turn-01a0…` | **HUB 格式** | null | — |
| 1 | artifact-summary | `turn-artifacts-tur…` | **HUB 格式** | null | `outputs/pelican-riding-bicycle.preview.png` + `pelican-riding-bicycle.svg` |
| 2 | user | `8de37226` | **null** | `27bb0b8b-…` | — |
| 3…22 | thinking / tool / agent | `f00e8586-thinking`、`tool-chatcmpl-tool…` 等 | **全部 null** | null | — |

`HUB 格式` = `turn-<sessionId>-<ordinal>-<uuid>`；`null` = 该块没有 `turnId` 字段。

### 2.2 两个条件叠加

**条件一：持久化/历史块完全没有 `turnId`。**
只有 `client_message_id`（`frontend/src/lib/client/types.ts` 的 `HistoryMessage` 有该字段，但没有 turn 身份）。所以同一轮在"持久化表示"与"带 runtime turnId 的 live 块"之间**不存在任何可匹配的键**。

**条件二：两个 live 块带 HUB turnId，却排在 user 块之前。**
分组规则的键解析（`turn-presentation.ts:45-54`）：

```ts
const key: string = block.kind === "user"
  ? `user:${block.id}`
  : block.kind === "artifact-summary" && identity
    ? ownerByTurnId.get(identity) ?? currentKey ?? `turn:${identity}`
    : currentKey && byKey.get(currentKey)?.blocks.some((entry) => entry.kind === "user")
      ? currentKey                                    // ← 要求 currentKey 组已含 user 块
      : identity ? `turn:${identity}` : currentKey ?? `orphan:${block.id}`;
```

- i=0 的 thinking 块：`currentKey` 还是 null → 落到 `identity ? \`turn:${identity}\`` → **新建碎片分组** `turn:<hubId>`；随后 `ownerByTurnId.set(hubId, "turn:<hubId>")`。
- i=1 的 artifact 块：`ownerByTurnId.get(hubId)` 命中 → **卡片也进了碎片分组**。
- i=2 的 user 块：新建 `user:8de37226`，`currentKey` 变成它。
- i≥3：`currentKey` 组已含 user 块 → 加入 `user:8de37226` ✓

于是**同一轮被永久切成两半**：一半是"live 块 + 卡片"，另一半是"用户消息 + 其余全部"。

### 2.3 为什么碎片会渲染成一行「Completed」

`ConversationBlocks.tsx` 的 `ConversationTurn` 对每个分组都渲染 `AgentActivity`；碎片组有 1 个 activity block（那个 thinking）→ 渲染成一行活动行；其 `lifecycle` 由 `turn-presentation.ts:76-80` 决定，非 active 分组一律 `settled` → 显示 "Completed"，时长取该组自身的时间跨度（此处 17s）。

**"提前 Completed" 就是这么来的**：它不是状态机提前 settle，而是**同一轮被切成两行，前一行天然是 settled**。

### 2.4 卡片位置为何是 i=1（推断）

实时 fold 的锚定链（`event-fold.ts:637-672`）中，`afterIdentifiedTurn`（`event-fold.ts:1590-1597`）返回"**最后一个携带该 turnId 的、非 artifact 的块**之后"：

```ts
for (...) { if (block.kind !== "artifact-summary" && "turnId" in block && block.turnId === turnId) last = i; }
return last >= 0 ? last + 1 : -1;
```

若 artifact 事件到达时**只有 i=0 的 thinking 块带该 turnId**，结果就是 1 —— 与实测位置吻合。此链接未插桩直接取证，标为推断（置信度高）。

---

## 3. 尚未验证的一环：live 块为何排在 user 块之前

这是唯一未解释的部分，也是选择修复方向的关键。已知线索：

- i=2 的 user 块带 `client_message_id` → 它是 `sendPrompt` 生成的**乐观块**，本应在数组最前。
- i=0 的 thinking 块 id 形如 `thinking-<turnId>-anonymous-1`，`anonymous` 对应 hub 的匿名 part 机制（`conversation-event-hub.ts` 的 `TurnState.activeAnonymousKey` / `anonymousSerial`）。
- i≥3 的块 id（`*-thinking`、`tool-chatcmpl-tool-…`）看起来来自**持久化历史**。

因此可疑的搬运路径是"某个 resync / prepend 把 live 块排到了乐观 user 块之前"，或"匿名 thinking 块的插入锚点算错"。**在取到顺序演变的证据前不要改代码。**

### 3.1 建议的探针（无需改源码）

沿用本次有效的手法——直接订阅 zustand store（页面内动态 import 即可，见 §5.1），在每次块数组变化时记录**顺序签名**：

```js
const store = globalThis.__probeStore;
let prevSig = null;
store.subscribe((state) => {
  const blocks = state.thread?.blocks ?? [];
  const sig = blocks.slice(0, 6).map((b) => `${b.kind}:${String(b.id).slice(0, 12)}:${b.turnId ? "T" : "-"}`).join("|");
  if (sig === prevSig) return;
  prevSig = sig;
  globalThis.__orderProbe.push({ at: Date.now(), sig, total: blocks.length, userIndex: blocks.findIndex((b) => b.kind === "user") });
});
```

再发一条会触发同类任务的消息（本会话已复现过一次），即可看出：thinking 块是在乐观 user 块之前插入的，还是被后续某次 resync 搬到了前面。**同一提交两次复现，或一次复现 + 一次顺序演变记录，就能定论。**

---

## 4. 修复方向（待选定）

| 方向 | 做法 | 优点 | 代价 / 风险 |
|---|---|---|---|
| **A（治本）** | 服务端把轮次身份持久化到会话消息上（与 `client_message_id` 同级），使 `convertHistoryToBlocks` 能给持久化块也写 `turnId` | 同一轮在两种表示下可统一；顺带根治"卡片不归属轮次"整类问题 | 改协议与存储；需要迁移与兼容策略 |
| **B（最局部）** | 分组加一遍后处理：把"不含 user 块的前导碎片"合并进**紧随其后的** user 轮次，并把 `ownerByTurnId` 的映射一并改向（否则卡片仍留在碎片） | 纯前端、改动面小、可加单测 | 启发式规则（"前导碎片属于下一轮"）；需确认不会误并真正独立的历史轮次 |
| **C** | 查明并修正 live 块先于 user 块的插入顺序（§3） | 顺序正确后 `currentKey` 天然已含 user 块，碎片不再产生，无需启发式 | 需先取得 §3 的证据；若根因在 resync 搬运，改动可能落到恢复路径 |

**建议**：先做 §3.1 的探针取证（成本极低），再在 **C** 与 **B** 之间选；**A** 作为长期方案单独立项。

---

## 5. 复现与观测手段

### 5.1 页面内可用的注入方式

`evaluate` 中的动态 `import()` 会被转译器改写为 `importModule(` 并抛 `ReferenceError`；需要模块时注入 `<script type="module">`：

```js
await tab.playwright.evaluate(() => {
  const s = document.createElement("script");
  s.type = "module";
  s.textContent = 'import * as tp from "/src/lib/conversation/turn-presentation.ts";'
    + ' import { useRuntimeStore } from "/src/lib/agent-runtime/index.ts";'
    + ' globalThis.__probeTp = tp; globalThis.__probeStore = useRuntimeStore;';
  document.head.appendChild(s);
});
// 之后即可在页面内直接调用：
//   __probeTp.buildTurnPresentations(__probeStore.getState().thread.blocks, {...})
//   __probeStore.getState().thread.blocks        ← 逐块查看 kind / id / turnId
```

这是本次定位的关键手段：**它绕过了 DOM 与虚拟化，直接回答"数据里到底有什么"**。

### 5.2 判断"当前轮次那一行"

取**最后一个非 `closed:` 的 `[data-state]` 行**。直接扫全部行会把更早轮次的行算进来，造成误报（本次前期就吃过这个亏）。

### 5.3 观察时序的两种监视器

- `frontend/scripts/uat-monitor.mjs`：`MutationObserver` 驱动的 DOM 状态跃迁记录器，**环形缓冲上限 400 条**。注意：长轮次里 400 条只覆盖约 90–100 秒，**现场很容易被挤出**——本次就是这样丢掉了第一手记录。
- **生命周期探针**（本次新增，无需改源码）：订阅 store，记录每次 `turnLifecycle` / `working` / `status` 变化及其时间戳。上限 300 条。用它可判定 settle 是"事件驱动"还是"看门狗"，只需把时间戳与会话事件日志对照。

### 5.4 一个我自己犯过的错，值得记录

**不要在读事件日志后立刻下结论**。我曾读 `/…/.pi-science/events/<hash>.jsonl` 后发现"没有 `agent_end`/`session.idle`"，据此推断那次 settle 来自看门狗——**正确**，因为 `agent_end`/`session.idle` 是在我读取**之后**才写入的（settle 发生在 `session.idle` 之后 24ms，属正常收尾）。教训：日志是流式追加的，判定"某事件不存在"必须用**settle 时刻之后**的快照。

### 5.5 输入环境特性（ZCode in-app browser）

- `requestAnimationFrame` 完全不触发；页面定时器节流到约 1 次/秒 → **不要用 `setInterval` 采样**（用 `MutationObserver` 或 store 订阅）；Playwright 的定位器 `click()` 会因稳定性检查超时，改用 `tab.cua.click({x, y})`。
- 发送提示后必须**验证发送生效**（`Stop generation` 出现 / 用户消息计数增加）；输入框里文字还在就是没发出去——我曾因此把"没有回复"误判为产品缺陷。

---

## 6. 相关代码索引

| 位置 | 作用 |
|---|---|
| `frontend/src/lib/conversation/turn-presentation.ts:34-61` | 分组与键解析（本次缺陷所在） |
| `frontend/src/lib/conversation/turn-presentation.ts:76-80` | 非 active 分组一律 `settled` → 碎片行显示 "Completed" |
| `frontend/src/components/conversation/ConversationBlocks.tsx:29-44` | 每个分组渲染 user / AgentActivity / 答案 / `turn.artifacts` |
| `frontend/src/lib/agent-runtime/event-fold.ts:637-672` | 实时 fold 的 artifact 锚定链 |
| `frontend/src/lib/agent-runtime/event-fold.ts:1590-1597` | `afterIdentifiedTurn`（§2.4 的推断依据） |
| `frontend/src/lib/agent-runtime/event-fold.ts:1425-1435` | `convertHistoryToBlocks` 构造 user 块（`timestamp` / `client_message_id`，**无 turnId**） |
| `apps/server/src/runtime/events/conversation-event-hub.ts:329-333, 798-801` | hub 生成 `turn-<session>-<ordinal>-<uuid>` |
| `apps/server/src/runtime/events/conversation-event-hub.ts:1031-1057` | `agent_settled` 分支：先发带身份的 `session.idle`，再清空身份 |

---

## 7. 当前仓库状态

- 分支 `pr-107`，HEAD `51a4e3a6`；已推送到 `origin/feat/scientific-activity-permission-artifacts`（本地与远端一致）。PR #107 为 31 个提交。
- CI（该提交）：`verify` ubuntu 5m3s ✅、windows 7m13s ✅、analyze ×2 ✅、CodeQL ✅；`macOS launcher smoke` 首次 ❌、重跑 ✅ —— 已确认为**测试自身对机器速度敏感**（`scripts/start.sh` 里控制面与前端**共用同一个 `STARTUP_DEADLINE`**，`PI_SCIENCE_STARTUP_TIMEOUT_SECONDS=3` 下控制面冷启动接近耗尽预算时，前端那次 `wait_for_health` 的轮询循环不再执行，于是输出 "did not become ready within the 3s startup deadline" 而非断言期望的 "frontend exited during startup"），本地同一提交跑 `bash scripts/test-launcher.sh` 通过。**与产品代码无关**，建议单独修该断言。
- 本次分析**未做任何提交**。工作区未提交改动：`docs/artifact-card-anchor-issue-handoff.md`（§10.1 双滚动容器的更正）、`frontend/scripts/uat-conversation.mjs`（分析前即存在）。
- 另：`apps/server/src/runtime/artifacts/turn-artifact-repository.ts` 的 `nextTurnOrdinal()` 自 `8d3fa0ef` 起已无生产调用方（仅自身测试），可清理。


## 8. 2026-09-24 复核与修复

### 更正

- `HistoryMessage` 已定义可选 turnId/runId，convertHistoryToBlocks 也支持它们。现场历史消息缺少字段值，不等于前端协议没有字段。
- client_message_id 同时用于乐观块和持久化用户消息，不能据此判断块来自哪条路径。
- §5.4 的“正确”应为“错误”：若 settle 在 session.idle 后发生，提前读取日志不能证明由看门狗触发。

### 已复现的代码路径

mergeHistoryWindow 原先将首个重合块之前的所有内容保留为“旧历史”。可控输入为 current=[live thinking, live tool]，snapshot=[user, durable tool]，工具块 ID 相同；即使 keepLiveExtras=false，也得到 [live thinking, user, durable tool]。附加 artifact 后，turnId 锚点将卡片插在 thinking 后，稳定复现两个分组。

另一个输入是已经污染的 [live thinking, artifact, durable user, durable tool]：首个重合块是 user，因此即使再次恢复完整历史，原实现仍保留前导碎片。

这证明缺陷存在于恢复合并边界；没有声称还原了原现场的全部事件时序。

### 修复策略

- 恢复层将 has_more=false 作为“完整历史”的明确证据传入合并层。完整且已收尾的快照直接替换内容，保留已有工具计时补全，不再保留假旧前缀，并采用快照分页边界。
- 分页窗口中，只有当重合块的 live turnId 能关联到快照内可见的用户边界时，才认定同 ID 的前导内容已被覆盖。没有用户边界的中途分页、不同轮次以及无法确认归属的前缀继续保留。
- 运行中恢复需要保留 live extras 时，将已确认归属的碎片放回对应用户轮次，不跨越下一条用户消息。
- 不增加“所有前导块都属于下一轮”的分组启发式，不修改生命周期逻辑或要求存储迁移。

回归覆盖：原始碎片输入、已经污染且身份丢失的完整窗口、真正的旧孤立轮次、中途分页、运行中内容保留、多轮快照归属。

验证：前端全量 135 个文件 / 1,167 项测试通过，typecheck、lint 与 git diff --check 通过。未运行真实模型任务；原始现场时序仍未还原。
