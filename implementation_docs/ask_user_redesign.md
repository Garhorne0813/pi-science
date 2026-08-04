````
# AskUserQuestion 表单(QuestionnairePrompt)重设计

## 背景与动机

AskUserQuestion 表单(`frontend/src/components/conversation/QuestionnairePrompt.tsx`)是 Pi 代理向用户询问结构化问题(带预览、多选、自定义答案、备注)的唯一入口。原实现为"标签页式向导 + 固定侧边预览面板 + 独立检查页",存在以下体验问题:

- **操作路径长**:每答一题要经过「选答案 → Next → 检查 → 提交」四步,检查页必须点穿
- **预览面板常驻右侧**,挤压主内容空间,小屏幕下几乎不可用
- **自定义答案与备注**是割裂的独立区块,交互沉重
- 标签页在问题多时横向溢出,可读性差

用户确认的目标:**全面视觉重设计**,让表单更紧凑、直接、现代化。

## 设计目标

1. 所有问题一屏可见,减少导航层级
2. 预览从"常驻面板"变为"按需出现",不再挤压内容
3. 自定义答案、备注内联化,随用随开
4. 提交入口常驻,不再需要单独的检查步骤
5. 整体垂直空间比原版压缩约 40%(两轮紧凑化调整后)

## 新设计

### 布局结构(自上而下)

```
┌────────────────────────────────────────────┐
│ ✨ Answer a few questions            ── 头部 │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░ 进度条          │
├────────────────────────────────────────────┤
│ ① 任务目标   你希望我做什么?            ▾   │ ← 手风琴卡片(展开态)
│   ○ 分析结构                             │
│   ○ 生成可视化                            │
│   ─ ─ 输入其他答案… ─ ─                    │
│   📝 本题备注                             │
│ ② 输出形式   (收起态,已答显示 ✓ + 答案)  ▾   │
├────────────────────────────────────────────┤
│ [📋 Review]               3/3 已答        │ ← 可展开的答案汇总
│ [← 返回] [下一步]      [取消] [提交答案 ✓] │ ← 页脚
└────────────────────────────────────────────┘
```

### 关键交互

| 交互 | 说明 |
|---|---|
| 手风琴 | 所有问题纵向堆叠,同时只展开一个;点击任意卡片头部切换 |
| 自动跳转 | **首次**答完单选题/保存自定义答案/「不选择任何选项」后,自动展开下一未答问题;多选切换与改答不跳转 |
| 内联预览 | 悬停带预览的选项时,预览条出现在选项下方;未悬停时回落到已选答案的预览;触屏设备点选即固定显示 |
| 内联自定义答案 | 虚线按钮展开 textarea + 保存/取消;保存后关闭并计入答案 |
| 备注折叠 | 默认收起为一行文字按钮;有内容时显示 accent 圆点;展开为 textarea |
| 答案汇总 | 页脚「Review」切换折叠列表,点击任一行跳回对应问题(取代原独立检查页) |
| 进度条 | 头部细条(填充 `h-1`、轨道无显式高度由内容撑起),`mt-1`,`aria-valuemax` = 问题总数 |
| 提交 | 全部答完即启用,常驻页脚右下;取消按钮紧随其左侧(由头部移入) |

### 单选 / 多选视觉区分

- 单选:圆形 radio,选中显示实心圆点
- 多选:方形 checkbox,选中显示 ✓
- 带预览的选项标有眼睛图标(aria-label "Has preview")

## 实现细节

### 文件改动

| 文件 | 改动 |
|---|---|
| `frontend/src/components/conversation/QuestionnairePrompt.tsx` | 完整重写(~390 行 → ~360 行) |
| `frontend/src/components/conversation/QuestionnairePrompt.test.tsx` | 测试更新为新交互流程 |
| `frontend/src/i18n/locales/en.json` | 新增 `questionnaire.hideReview`;移除 7 个失效键 |
| `frontend/src/i18n/locales/zh-Hans.json` | 同上 |

### 组件状态

```ts
openIndex      // 当前展开的问题下标(原 activeIndex)
summaryOpen    // 答案汇总折叠
answers[]      // 每题答案(结构不变)
notes[]        // 每题备注草稿
notesOpen[]    // 每题备注展开态(新增)
customDrafts[] // 自定义答案草稿
customOpen[]   // 自定义答案展开态
hoveredOption  // 当前悬停选项下标(预览用)
submitting     // 提交中
```

### 不变的契约(重要)

- 组件 API:`questionnaire` / `interaction` / `onRespond`,`LiveSessionPage.tsx` 零改动
- 提交 payload 结构不变:

```ts
{ cancelled: false, answers: [{ questionIndex, question, kind: "option" | "custom" | "multi", answer, selected?, notes?, preview? }] }
```

- `data-request-id` 属性保留

### 移除的 i18n 键

`questions`、`reviewTitle`、`multiHint`、`singleHint`、`previewHint`、`noPreview`、`navigationHint`(重设计后无引用,已从 en/zh 两个 locale 移除;其余键全部保留复用)

## 与最初计划的一处偏差

计划中预览采用"popover 悬停弹出"。实际实现为**卡片内联预览条**,原因:

1. 表单位于会话流内,外层 section 有 `overflow-hidden`,绝对定位弹出层会被裁切
2. 项目内没有 Radix Popover 使用先例(仅 DropdownMenu)
3. 内联条在触屏设备上可用(点选即固定显示)

若需恢复弹出式预览,可改用 `@radix-ui/react-popover`(项目已依赖)迭代。

## 紧凑化记录

两轮紧凑化调整(用户要求"更紧凑"、"再紧凑一些"):

**第一轮**:头部 `py-3→py-2.5`、卡片间距 `space-y-2→1.5`、选项 `gap-2→1.5`、按钮 `py-2.5→2`、textarea `rows=3→2`、`leading-relaxed→snug` 等,垂直空间约 -20%。

**第二轮**:
- 删除展开区提示行(multiHint/singleHint 整行)
- 头部精简为单行(移除进度文字,图标 `h-8→h-6`)
- 全局再降一档 padding:卡片头 `py-1.5`、选项按钮 `py-1.5`、页脚 `py-2` 等

**微调**:
- 取消按钮从头部右上移至页脚提交按钮左侧(带边框样式与 Back/Next 一致)
- 进度条改为 `mt-1`,轨道不再显式设 `h-1`(高度由填充条 `h-1` 撑起)
- 问题卡片容器移除 `py-2.5`,卡片紧贴头部/页脚边框

## 验证

```bash
pnpm typecheck    # ✅ 通过
npx vitest run src/components/conversation/QuestionnairePrompt.test.tsx  # ✅ 2/2
npx vitest run    # ✅ 306/307(唯一失败为 office-dependencies 懒加载超时,单独运行通过,与本次改动无关)
```

- UAT 脚本(`scripts/uat-*.mjs`)不涉及问卷表单选择器,无需更新
- 测试契约断言(提交 payload 结构)保持不变,仅点击流程按新 UI 重写

````
