# PRD：Narration Subsumption 安全边界与消息状态一致性

> 状态：Proposed / Implemented with PR #97 follow-up  
> 适用范围：frontend agent runtime / conversation presentation  
> 目标分支：`feat/progress-visual-settings`  
> 关联 PR：#97  
> 日期：2026-09-16

## 1. 背景

PR #97 在 conversation UI 中引入了更完整的 live progress / process trace 展示。为解决部分模型在每个 assistant message 开头重复此前 narration 的问题，`frontend/src/lib/agent-runtime/event-fold.ts` 增加了 `narrationSubsumption()`：当新 narration 与上一条同 turn narration 存在高比例、边缘对齐的近乎逐字重复时，frontend projection 会折叠重复内容，避免 feed 中出现 `A → B+A → C+B+A` 的堆叠。

该优化方向是正确的，但它位于 transport event folding 层，而不是 React render 层，因此会影响 frontend `Thread.blocks`、`Thread.index` 与 `EventFoldState.textByKey` 的结构。与此同时，项目还有另一套独立的 message cache：`frontend/src/lib/client/message-cache.ts` 将 server 返回的 `HistoryMessage[]` 直接缓存到 localStorage。

因此需要明确：哪些数据是 source of truth，哪些数据只是 frontend projection；哪些重复内容可以安全折叠，哪些语义消息绝不能被吞掉；以及 live event path 与 history rebuild path 必须满足哪些一致性条件。

---

## 2. 问题定义

当前 narration subsumption 有两个需要修复的安全问题。

### 2.1 Incoming explicit final 可能被误判为 `subsumed`

`narrationSubsumption(previous, nextText)` 只保护 `previous.presentationRole === "final"`，不知道 incoming message 的 role。

因此当：

```text
previous: intermediate, text = X
incoming: final,        text = X
```

时，函数会因为 `candidate === previousText` 返回 `subsumed`。live folding path 随后可能跳过 final block 的创建。

但 history rebuild path 又显式跳过 final dedup，因此可能出现：

```text
live UI:    final block 缺失
refresh 后: final block 出现
```

这违反了 explicit final 的 authoritative semantic contract，也造成 live/history divergence。

### 2.2 Synthetic `subsumed-*` block id 改变 `TextFoldState.blockId` 语义

当前 subsumed path 会把：

```ts
blockId: `subsumed-${blockId}`
```

写入 `foldState.textByKey`。

这带来两个问题：

1. `TextFoldState.blockId` 不再是稳定的 logical block identity，而混入 presentation sentinel；
2. 同一 logical item 后续 revision 再次被 subsume 时，存在形成 `subsumed-subsumed-*` 链的风险。

即使这不一定立即触发生产故障，也会使 reducer state 语义变得隐式且难以调试。

---

## 3. 数据分层与 source of truth

本方案明确区分四层。

### 3.1 Runtime / server durable history

包括 provider/runtime 产生的原始 assistant message、tool result、turn metadata 与 server 持久化历史。

这是会话内容的 durable source of truth。Narration subsumption 不得修改这一层。

### 3.2 Frontend message cache

`message-cache.ts` 缓存：

```ts
HistoryMessage[]
```

用途是 session 切换时快速恢复历史，再由 `convertHistoryToBlocks()` 投影成 UI thread。

Narration subsumption 不得删除或改写 localStorage 中的 `HistoryMessage[]`。缓存容量、TTL、LRU 与 key 规则均保持不变。

### 3.3 Frontend Thread projection

`event-fold.ts` 输出：

```ts
interface Thread {
  blocks: ThreadBlock[];
  index: Record<string, number>;
  foldState?: EventFoldState;
}
```

该层是 transport/history 到 conversation presentation model 的 projection，不是 server durable history 的替代品。

重复 intermediate narration 可以在该层被 presentation-normalize，但必须遵守本文定义的语义不变量。

### 3.4 React presentation

`TurnPresentation` / `AgentActivity` / `ConversationTurn` 决定：

- process trace 是否折叠；
- final/provisional answer 放在哪里；
- thinking/tool/intermediate narration 如何展示。

该层不得依赖 `subsumed-*` 之类字符串约定解释 reducer state。

---

## 4. 产品目标

### 4.1 核心目标

1. 保留 narration dedup 的 UX 收益，避免近乎逐字重复的中间叙述堆叠。
2. explicit final 永远不能因为 narration overlap 被删除或跳过。
3. live folding 与 history rebuild 对 final semantics 保持一致。
4. `TextFoldState.blockId` 保持稳定 logical identity，不再编码 `subsumed-*` sentinel。
5. suppression 状态必须显式建模，便于 debug 与后续演进。
6. 不修改 server durable history 与 localStorage `HistoryMessage[]` cache。

### 4.2 非目标

本次不做：

- 不修改 provider wire protocol；
- 不新增 server database migration；
- 不改变 message-cache TTL/LRU/size；
- 不改变当前 near-verbatim overlap 阈值；
- 不把 narration dedup 整体迁移到 React render 层；
- 不改变 final answer 的 Markdown / code / citation 渲染；
- 不扩大 PR #97 的 progress visual scope。

将 dedup 完全迁移到 presentation derivation 是可选后续方案，但会改变 `Thread.blocks` 现有 projection contract、history merge 行为与大量测试，本次优先修复明确的语义与状态一致性风险。

---

## 5. 设计原则与不变量

### INV-01：Explicit final 不可 subsume

如果 incoming message 的 `presentationRole === "final"`，narration subsumption 必须返回 `keep`。

无论：

- 文本与 previous intermediate 完全相同；
- incoming 是 previous 的 prefix/suffix；
- previous 是 incoming 的 prefix/suffix。

都不得跳过 explicit final block。

### INV-02：Previous final 不可被替换

如果 previous agent block 是 explicit final，则后续 narration overlap 不得删除或替换它。

### INV-03：Final protection 必须集中在 matcher 内

不能只依赖 caller 传 `allowDrop=false`。Final semantic 是 domain invariant，应由 `narrationSubsumption()` 本身同时检查 previous role 与 incoming role。

这样新增 caller 时不会再次出现漏保护。

### INV-04：Logical block id 稳定

一次 logical text item 的 `TextFoldState.blockId` 必须维持原始 block identity，例如：

```text
agent-t1-m2
```

不得改写为：

```text
subsumed-agent-t1-m2
subsumed-subsumed-agent-t1-m2
```

### INV-05：Suppression 显式建模

当 text item 因为 narration overlap 没有 materialize 到 `Thread.blocks` 时：

```ts
TextFoldState.suppressed === true
```

其 `blockId` 仍然保持 logical target id。

### INV-06：后续 revision 可恢复 materialization

被 suppressed 的 logical item 后续如果产生新的、不能被 subsume 的文本，仍然必须能够以原 block id 正常创建 agent block。

因此 suppression 不能通过制造不存在的新 block id 来“永久隔离”该 item。

### INV-07：Cache 不受影响

`cacheMessages()` / `readCachedMessages()` 的数据结构与行为完全不变。刷新后 history projection 可以再次执行同一 narration normalization，但 raw cached `HistoryMessage[]` 仍完整保留。

---

## 6. Near-verbatim 判定规则

继续沿用当前保守规则：

1. 空文本 → `keep`
2. incoming 等于 previous → `subsumed`
3. `shorter < 12` → `keep`
4. `shorter / longer < 0.6` → `keep`
5. incoming 从 previous 开始或以 previous 结束 → `replaced`
6. previous 从 incoming 开始或以 incoming 结束 → `subsumed`
7. 其他 → `keep`

新增最高优先级规则：

```ts
if (previous.presentationRole === "final" || nextRole === "final") {
  return "keep";
}
```

`presentationRole` 优先于字符串 overlap heuristic。

---

## 7. Reducer state 设计

### 7.1 TextFoldState

新增：

```ts
interface TextFoldState {
  text: string;
  revision: number;
  blockId: string;
  partId: string;
  suppressed?: boolean;
  segments?: TextSegment[];
}
```

语义：

- `blockId`：logical target block identity；
- `suppressed=true`：该 logical item 当前没有 materialize 成 `Thread.blocks` 中的 agent block，因为其文本已被邻近 same-turn narration 覆盖；
- `suppressed` 缺失/false：正常 materialized 或尚未有非空文本。

### 7.2 Subsumed path

旧：

```ts
foldState.textByKey[key] = {
  text: nextText,
  revision,
  blockId: `subsumed-${blockId}`,
  partId,
};
```

新：

```ts
foldState.textByKey[key] = {
  text: nextText,
  revision,
  blockId,
  partId,
  suppressed: true,
};
```

### 7.3 Materialized path

一旦 item 正常创建/更新 block，新的 `TextFoldState` 不带 `suppressed`，自然清除 suppression 状态。

---

## 8. Live / History 一致性

### 8.1 Live path

`text.updated` 新 block 与 post-tool legacy split 都调用：

```ts
reconcileRepeatedNarration(
  blocks,
  index,
  turnId,
  nextText,
  role,
)
```

matcher 负责 final protection。

### 8.2 History rebuild

`convertHistoryToBlocks()` 调用：

```ts
narrationSubsumption(block, text, msg.presentationRole)
```

不再使用外层 `if (msg.presentationRole !== "final")` 作为唯一保护。

这样 live/history 使用同一语义入口。

### 8.3 预期行为矩阵

| Previous | Incoming | Text relation | 结果 |
|---|---|---|---|
| intermediate | intermediate | equal | incoming suppressed |
| intermediate | intermediate | incoming superset | previous replaced |
| intermediate | final | equal | both kept |
| intermediate | final | overlap | both kept |
| final | intermediate | equal/overlap | both kept |
| final | final | equal/overlap | both kept |
| intermediate | intermediate | short overlap | both kept |

---

## 9. Cache 与恢复行为

### 9.1 localStorage

本方案不修改：

```text
pi-science.msg-cache
```

缓存仍保存完整 `HistoryMessage[]`。

### 9.2 Session reload

流程：

```text
HistoryMessage[] (cache/server)
        ↓
convertHistoryToBlocks()
        ↓
Thread projection
        ↓
TurnPresentation
```

重复 intermediate narration 可能在 projection 中再次被折叠；explicit final 必须始终 materialize。

### 9.3 Debugging contract

如果 UI 中某 intermediate narration 被折叠，排障时应检查：

- raw HistoryMessage cache / server history；
- `foldState.textByKey[key].suppressed`；
- `foldState.textByKey[key].blockId`；
- `Thread.index[blockId]`。

`suppressed=true` 且 `Thread.index[blockId] === undefined` 是合法状态，不再需要解析 block id 前缀。

---

## 10. 验收标准

### AC-01 Explicit final identical to intermediate

输入：

```text
intermediate: "这是经过完整验证的最终回答正文。"
final:        "这是经过完整验证的最终回答正文。"
```

验收：

- `Thread.blocks` 有两个 agent blocks；
- 第二个 block `presentationRole === "final"`；
- final 的 `TextFoldState.suppressed !== true`。

### AC-02 Stable suppression id

输入：同一 intermediate item 多次 replace revision，文本持续与 previous narration 相同。

验收：

- 第一次 suppression 后 `blockId` 等于 logical id；
- 后续 revision 的 `blockId` 不变；
- 不包含 `subsumed-`；
- `suppressed === true`。

### AC-03 History parity

相同的 intermediate/final history rebuild 后：

- final 仍存在；
- role 与 live path 一致。

### AC-04 Existing dedup behavior retained

已有测试继续保证：

- substantial edge repeats 会 collapse；
- 短文本如 `Done` 不会因普通 substring 被误删；
- 不跨 user turn boundary dedup。

### AC-05 Cache contract unchanged

`message-cache.test.ts` 全部通过，无 schema migration。

---

## 11. 测试方案

新增独立 regression test：

```text
frontend/src/lib/agent-runtime/event-fold.narration-subsumption.test.ts
```

覆盖：

1. incoming explicit final 与 intermediate 完全相同时仍 materialize；
2. suppressed item 多 revision 下 logical block id 稳定；
3. live 与 history final semantics 一致。

同时运行现有：

- `event-fold.test.ts`
- `message-cache.test.ts`
- `turn-presentation.test.ts`
- frontend full test suite
- frontend build/typecheck

---

## 12. 风险分析

### 12.1 风险：suppressed blockId 不存在于 Thread.index

这是有意状态，但必须显式通过 `suppressed` 表达。调用方不能假设所有 `textByKey[*].blockId` 都已 materialize。

### 12.2 风险：旧代码依赖 `subsumed-*` 字符串

当前仓库没有正式 contract 要求解析此前缀。移除此前缀是 reducer internal cleanup。Review 时应搜索 `subsumed-`，确保不存在其他依赖。

### 12.3 风险：final 重复显示

当 provider 同时发送 intermediate 与内容完全相同的 explicit final，UI process trace 可能保留 intermediate，同时主回答显示 final。这是正确的语义结果：intermediate 属于 process history，final 是 authoritative answer。Settled UI 默认会折叠 process trace，因此不会造成主聊天区双重最终答案。

### 12.4 风险：完全迁移 presentation-layer dedup 的技术债

当前实现仍允许 event-fold 改变 `Thread.blocks` 的 intermediate narration 数量。若未来需要把 `Thread.blocks` 用作 forensic trajectory export 或严格事件回放，应另立 PR 将 narration normalization 移到 `TurnPresentation` derivation，并保留完整 projected block sequence。

本 PR 不扩大该架构变更，以控制 #97 风险面。

---

## 13. Rollout / Observability

无需 feature flag；变更只收紧 final semantics 与 reducer state identity。

建议观察：

- “No final answer returned” 异常出现率；
- session refresh 前后 final answer 是否跳变；
- reducer recovery / history reconciliation 测试；
- V2 sequence gap 与 speculative event tests；
- CI 中 frontend test/build。

若出现 regression，可单独回滚该 commit，不涉及 server schema 或持久化迁移。

---

## 14. Code review checklist

- [ ] `narrationSubsumption()` 同时检查 previous 与 incoming final role。
- [ ] 所有 live caller 都传 incoming role。
- [ ] history caller 使用同一 matcher semantic。
- [ ] subsumed path 不再生成 `subsumed-*` block id。
- [ ] `TextFoldState.suppressed` 有明确注释。
- [ ] suppressed item 后续 revision 仍能正常恢复 materialization。
- [ ] 无 localStorage cache schema 修改。
- [ ] 无 server/runtime protocol 修改。
- [ ] regression tests 覆盖 final/live/history/id stability。
- [ ] PR #97 CI 通过后再合并。

---

## 15. 决策结论

本次采用“**保留 frontend projection dedup，但强化 semantic guard 与 state identity**”方案：

- raw server history 与 message cache 保持完整；
- `Thread.blocks` 继续承担 presentation-normalized projection；
- explicit final 永不参与 narration subsumption；
- suppression 通过字段显式建模；
- logical block id 稳定，不再编码 sentinel；
- live/history 使用同一语义判定。

该方案在不扩大 PR #97 架构范围的前提下，修复当前最严重的 final 丢失与 reducer state 语义不稳定问题，并为未来将 dedup 下沉到更纯粹的 presentation derivation 层保留清晰迁移路径。
