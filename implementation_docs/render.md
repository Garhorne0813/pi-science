````
# 滚动页面导致问卷表单已选选项被清空问题修复

## 问题描述

问卷表单弹出后,用户选中一个选项,然后**滚动页面**,表单的已选选项被清空(备注、自定义草稿、展开状态一并丢失)——表单状态回到了初始空表单。

## 根因分析

这是经典的 React "render 内定义组件" bug,触发链完整闭合:

### 1. 滚动触发父组件重渲染

`frontend/src/app/routes/LiveSessionPage.tsx` 的滚动监听:

```tsx
const handleThreadScroll = useCallback(() => {
  const scroller = scrollRef.current;
  if (!scroller) return;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  followOutputRef.current = nearBottom;
  setShowScrollDown(!nearBottom);   // ← 每次滚动都 setState
}, []);
```

滚动 → `setShowScrollDown` → `LiveSessionPage` 重新渲染。

### 2. 内联 Footer 组件导致重挂

`react-virtuoso` 的 `components.Footer` 是**内联箭头函数**:

```tsx
<LazyVirtuoso
  components={{
    Footer: () => (        // ← 每次父组件渲染都是新函数引用
      ...
      {renderInteractionPrompt()}
      ...
    ),
  }}
/>
```

`components.Footer` 的类型是 `ComponentType`,被 React 当作组件类型渲染。**每次父组件重新渲染,内联箭头函数产生新的引用 → React 判定组件类型变化 → 卸载旧 Footer、挂载新 Footer**。

### 3. 表单随 Footer 销毁

`QuestionnairePrompt` 挂在 Footer 内。Footer 重挂 = 表单组件卸载重建 → 所有 `useState`(answers、notes、customDrafts、customOpen、openIndex 等)全部重置为空。

```
滚动 → handleThreadScroll → setShowScrollDown → LiveSessionPage re-render
  → components.Footer 新函数引用 → Virtuoso 重挂 Footer
  → QuestionnairePrompt 卸载重挂 → 已选选项清空
```

## 修复方法

把 Footer 提取为**模块级组件**(引用稳定,不随父组件渲染变化):

```tsx
/**
 * Module-level (stable reference) Footer for the virtual conversation list.
 * Passing an inline arrow function here would remount the whole footer — and
 * with it the questionnaire form and its answer state — on every parent
 * re-render (any scroll triggers setShowScrollDown). Reads interaction state
 * directly from the runtime store instead of closing over the page's copy.
 */
function ConversationFooter() {
  const pendingInteraction = useRuntimeStore((s) => s.pendingInteraction);
  const pendingQuestionnaire = useRuntimeStore((s) => s.pendingQuestionnaire);
  const working = useRuntimeStore((s) => s.working);
  const respondToInteraction = useRuntimeStore((s) => s.respondToInteraction);
  // ...渲染逻辑与原 renderInteractionPrompt 一致
}

// Virtuoso:
components={{ Footer: ConversationFooter }}
```

关键点:

- **模块级引用稳定** → 父组件 re-render 时 Footer 元素类型不变 → React 保留实例(仅更新 props)→ 表单 `useState` 状态保留
- **直接从 store 读取状态**(`useRuntimeStore` selector),不再闭包页面组件的副本——字段级 selector 只在相关字段变化时触发 Footer 自身 re-render
- 非虚拟列表分支(空会话时无消息列表)保留原 `renderInteractionPrompt` 内联调用,不受影响

## 改动文件

| 文件 | 改动 |
|---|---|
| `frontend/src/app/routes/LiveSessionPage.tsx` | 新增模块级 `ConversationFooter`;`components.Footer` 指向它 |

## 验证

```bash
pnpm typecheck                                       # ✅ contracts + server + frontend
cd frontend && npx vitest run src/app/routes/LiveSessionPage.test.tsx   # 29/29 ✅
```

手动验证:表单弹出 → 选择选项 → 滚动页面 → 已选选项保留。

## 附:同类隐患

`components.Header` 同样是内联箭头函数,存在同类重挂风险。当前 Header 内没有状态表单(仅 research 卡片、加载指示器,数据在 store/hook 中),重挂无感,故本次未处理;若日后 Header 增加有状态交互组件,应按同样方式提取为模块级组件。

````
