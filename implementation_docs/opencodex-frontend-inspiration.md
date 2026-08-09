# OpenCodex 前端设计对 Pi-Science 的启发

> 分析对象：`../OpenCodex` 与当前 `pi-science` checkout  
> 分析时间：2026-08-09  
> 分析范围：Todo、标签页、设置页、图标、色彩、间距与响应式布局

## 结论

OpenCodex 最值得 Pi-Science 学习的不是配色或某个孤立组件，而是三项界面组织原则：

1. 更扁平的视觉层级：内部工具界面主要依靠留白、背景差和弱边框组织，而不是让每个区域都成为一张悬浮卡片。
2. 更稳定的密度体系：导航行、标签、图标按钮、设置行和页面边距遵循少量可预测的尺寸。
3. 默认收起、按需展开：任务状态、运行过程和次级操作不会长期抢占主内容空间。

Pi-Science 已经有明确的暖色品牌、较完整的功能组件和良好的交互基础。当前主要问题不是“设计不足”，而是 Todo、Inspector、设置、项目卡片等区域各自形成了自己的尺寸和层级语言，造成整体密度不统一；同时大量 `10px`、`11px` 文本和低透明度元信息也降低了可读性。

需要特别说明：OpenCodex 的主界面并不是一套独立重写的 React 前端，而是复用官方 Codex/ChatGPT Desktop UI，并在外层增加启动器、窗口控件、工作区选择、移动端适配和模型路由设置。因此，本文建议吸收其界面原则和尺寸体系，不建议直接复制实现代码。

## 总体判断与优先级

| 区域 | Pi-Science 现状 | 建议方向 | 优先级 |
| --- | --- | --- | --- |
| Todo | Sticky/FAB 两套模式、可拖动、自动展开、百分比和 Popover | 收敛为单一“紧凑状态条 + 展开列表” | P0 |
| Inspector 标签页 | 36px 高、标签间垂直边框、背景与底线同时表示选中 | 改为 32px 扁平标签，只保留一个选中信号 | P0 |
| 字号与间距 | 大量 `10px`、`11px` 和任意 Tailwind 数值 | 建立统一密度 token，正文最低 13px、元信息最低 12px | P0 |
| 设置页 | 760px 模态框内包含 176px 导航，复杂设置区域偏窄 | 桌面扩大到约 900–960px，重新分组；移动端使用两级导航 | P1 |
| 图标 | 已使用 Lucide，但尺寸、线宽和颜色语义不完全统一 | 保留 Lucide，增加统一 `Icon` 和 `IconButton` 组件 | P1 |
| 色彩与卡片 | 暖色有辨识度，但卡片、边框和阴影同时使用较多 | 保留暖色品牌，减少内部工具界面的卡片化 | P1 |
| 项目与会话导航 | 功能完整，但分组标题和元信息偏小、偏淡 | 统一为 32px 行高和 12–13px 文本 | P1 |
| 移动端 | Todo FAB、Inspector 控制和 Composer 可能竞争空间 | Todo 改为底部 Sheet，设置改为两级全屏页面 | P2 |

## 一、Todo：从“浮动工具”改为“过程状态”

### 当前实现

Pi-Science 当前同时提供两套 Todo 表现：

- `TodoWidget`：可拖动的悬浮胶囊，点击后打开 Popover；
- `TodoStickyBar`：固定在对话顶部的进度条，点击后展开任务列表；
- 自动展开一次；
- 可在两种模式间切换；
- 展示百分比、完成数、任务总数和当前任务；
- FAB 位置写入 `localStorage`，窗口变化时通过 `ResizeObserver` 约束回可见范围。

相关文件：

- `frontend/src/components/todo/TodoWidget.tsx`
- `frontend/src/components/todo/TodoStickyBar.tsx`
- `frontend/src/components/todo/TodoTaskRow.tsx`
- `frontend/src/components/todo/useTodoAutoOpenOnce.ts`

这套实现功能完整，但需要用户理解 Todo 的位置、拖动、自动打开和模式切换等额外概念。Todo 本应表达“Agent 当前做到哪里”，不应成为一个需要单独管理的小应用。

### OpenCodex 带来的启发

OpenCodex/Codex 更倾向于把过程状态表示为紧凑、可展开的行：默认只暴露当前状态和摘要，细节在用户点击时展开。执行过程也直接嵌入对话时间线，而不是永久悬浮在主内容之上。

### 推荐设计

只保留一种 Todo 模式：

```text
┌─────────────────────────────────────────────────────────┐
│ ◐  2/3   正在整理可落地的设计建议                  ⌄   │
└─────────────────────────────────────────────────────────┘
```

展开后：

```text
┌─────────────────────────────────────────────────────────┐
│ ◐  2/3   正在整理可落地的设计建议                  ⌃   │
├─────────────────────────────────────────────────────────┤
│ ✓  核对前端结构和设计 token                            │
│ ✓  对比 Todo、标签页、设置页和图标                     │
│ ◐  整理建议与优先级                                    │
└─────────────────────────────────────────────────────────┘
```

具体规则：

1. 桌面端固定在对话区域顶部，单行高度 36px，不再允许拖动。
2. 默认只显示状态图标、`已完成/总数`、当前任务名和展开箭头。
3. 不显示百分比。对于 3–6 条任务，`2/3` 比 `67%` 更直接，也避免虚假精确度。
4. Todo 完成后不要立即消失，保留一条低强调的“已完成 3/3”，默认折叠。
5. Todo 进入新 streak 时可以自动展开一次，但用户手动关闭后不应反复打开。
6. 移动端使用底部 Sheet 展示任务列表，不使用可拖动 FAB，避免和 Composer、预览栏控制竞争空间。
7. 展开列表仍然只读；任务状态由 Agent 事件驱动，不在前端维护第二套可编辑状态。

### 字号调整

当前紧凑 Todo 中存在大量 `10px` 和 `11px` 文本。建议调整为：

- 状态条和任务名：13px；
- 辅助状态、耗时和依赖：12px；
- Badge 在空间非常有限时可以使用 11px；
- 不再使用 10px 的普通文本。

## 二、Inspector 标签页：降低浏览器标签感

### 当前实现

`frontend/src/components/inspector/InspectorTabs.tsx` 当前标签栏具有以下特征：

- 高度 36px；
- 每个标签最小宽度 112px、最大宽度 192px；
- 标签之间存在垂直边框；
- 选中时同时使用 `surface-2` 背景和 2px Accent 底线；
- 非活跃标签的关闭按钮在 hover/focus 时显示；
- 标签栏底部另有滚动位置指示器。

单个特征都合理，但叠加后层级信号过多。文件预览区域因此更像浏览器，而不是科研工作台的 Inspector。

### OpenCodex 带来的启发

OpenCodex 的任务头部、侧边面板和标题区域通常采用“扁平标题 + 弱选中态 + 右侧操作”。它不会为每个打开对象同时添加背景、边框、底线和阴影。

### 推荐设计

1. 标签栏高度从 36px 改为 32px。
2. 标签最小宽度改为约 88px，最大宽度改为约 160px。
3. 去掉标签之间的垂直边框。
4. 选中状态只保留一种视觉信号。建议保留 2px Accent 底线，背景只在 hover 时出现。
5. 文件类型图标放在标题之前，图标 14px；关闭按钮 12–14px。
6. 关闭按钮只在 hover、focus 或 active 标签中显示。
7. 溢出时使用左右滚动按钮或“更多标签”菜单，不再额外绘制模拟滚动条。
8. 标签栏右侧建立固定的 28×28px 工具区，用于最大化、关闭 Inspector 等操作，避免和标签争抢空间。

建议后续加入“预览标签”语义：

- 单击文件时复用一个临时标签；
- 双击、编辑或显式固定后转为普通标签；
- 打开下一个文件时替换尚未固定的预览标签。

这对科研项目尤其有价值，因为用户经常需要快速浏览大量数据、图片和中间产物，而不希望每次浏览都永久增加一个标签。

## 三、设置页：保留模态框，但扩大并重新分组

### 当前实现

Pi-Science 的设置页已经具备较完整的交互基础：

- 左侧垂直 Tab 导航；
- 右侧滚动内容；
- 键盘方向键、Home/End 导航；
- 焦点恢复与焦点圈定；
- 桌面 Modal、移动端全屏；
- 常规、模型、扩展、MCP、计算五个一级页面。

相关文件：

- `frontend/src/components/settings/SettingsDialog.tsx`
- `frontend/src/components/settings/SettingsContent.tsx`
- `frontend/src/components/settings/Section.tsx`
- `frontend/src/components/settings/GeneralTab.tsx`
- `frontend/src/components/settings/LLMTab.tsx`
- `frontend/src/components/settings/ExtensionsTab.tsx`
- `frontend/src/components/settings/MCPTab.tsx`
- `frontend/src/components/settings/ComputeSettings.tsx`

当前桌面 Modal 最大宽度为 760px，而左侧导航占 176px，复杂的模型、计算、MCP 设置只能使用约 580px。随着设置项增加，右侧容易出现控件堆叠和说明文字换行过多的问题。

### OpenCodex 带来的启发

OpenCodex 的自定义模型路由设置页采用了一套稳定尺寸：

- 正文宽度 760px；
- 页面横向 padding 36px；
- 分组间距 22px；
- 卡片圆角 12px；
- 设置行 padding 为 `13px 14px`；
- 设置行两列布局，控制区约占 46%；
- 开关尺寸为 36×20px；
- 窄屏再退化为单列。

参考：`../OpenCodex/web-shell/codex-smart-model-router-settings.css`。

### 推荐设计

Pi-Science 当前只有五个一级设置页面，暂时没有必要照搬 OpenCodex 的全页面设置。更适合的调整是：

1. 桌面 Modal 调整为 `900–960px × min(88vh, 900px)`。
2. 左侧导航宽度调整为 188–196px。
3. 右侧正文最大宽度约 640px，并在剩余区域中居中。
4. 导航按语义分组：

   ```text
   基础
     常规

   AI
     模型
     计算

   集成
     扩展
     MCP
   ```

5. 设置项继续增长后，再在导航顶部增加搜索框。
6. 每个设置组使用一张扁平卡片；每一行左侧为标题和说明，右侧为控件。
7. API Key、删除和高风险设置独立成区，不与普通开关混排。
8. 桌面端继续保留关闭按钮；如果未来改为独立设置路由，再改成“返回应用”。

### 移动端

当前移动端通过 64px 图标栏承载一级设置导航。对于扩展、MCP、模型等非直观图标，这种方式识别成本较高。

建议改为两级全屏页面：

```text
设置分类列表 → 具体设置页面
```

一级页面显示完整文字、图标和简短说明；进入详情后使用返回按钮。这样比在窄屏长期保留图标栏更节省空间，也更容易理解。

## 四、图标：保留 Lucide，统一尺寸和语义

Pi-Science 已经使用 Lucide，没有更换图标库的必要。OpenCodex 的优势主要在于：图标不承担装饰作用，只用于导航、操作和状态识别。

建议新增两个基础组件：

```tsx
<Icon icon={FileText} size="nav" />
<IconButton icon={X} label="关闭" size="compact" />
```

建议尺寸体系：

| 场景 | 图标尺寸 | 控件尺寸 |
| --- | --- | --- |
| 元信息、紧凑列表 | 14px | 24–28px |
| 导航、普通按钮、标签 | 16px | 28–32px |
| 页面标题、重要空状态 | 18–20px | 36–40px |
| 移动端图标按钮 | 16px | 至少 40×40px 触控热区 |

统一规则：

- 默认 `strokeWidth` 使用 1.5 或 1.75；
- 默认颜色为 `muted`；
- hover/focus 变为 `text`；
- 当前项使用 `accent`；
- 成功、警告、错误色只用于真实状态；
- Flask、Molecule 等科学图标可作为产品特征保留；
- 文件、设置、关闭、展开等通用动作继续使用通用图标。

不建议同时散布 12、13、14、15、16px 等相邻图标尺寸，应让尺寸本身也表达层级。

## 五、建立统一的密度与间距体系

### 当前问题

`frontend/src/index.css` 和 `frontend/tailwind.config.js` 已经统一了颜色、圆角和阴影，但组件中仍有大量任意值：

- `text-[10px]`
- `text-[11px]`
- `h-7`
- `h-8`
- `px-1.5`
- `gap-px`

这些值单独看都很小，但长期累积后会让导航、Todo、设置、Inspector 和项目页形成不同的密度体系。

### 推荐基线

| Token/场景 | 建议值 |
| --- | --- |
| 应用 Header | 44px |
| 普通导航行 | 32px |
| 紧凑工具行 | 28px |
| 输入框、次级按钮 | 36px |
| 主按钮 | 40px |
| 桌面图标按钮 | 28×28px |
| 移动端触控热区 | 至少 40×40px |
| 页面横向 padding | 24px |
| 普通卡片 padding | 12px 或 16px |
| 卡片间距 | 12px |
| 设置分组间距 | 20–22px |
| 页面正文 | 14–15px |
| 导航、标签、设置标题 | 13px |
| 元信息 | 12px |
| Badge | 10–11px，仅限空间受限场景 |

建议将这些值加入 Tailwind theme 或共享组件，不再依赖每个组件自行组合 arbitrary values。

### Sidebar

Pi-Science 当前 Sidebar 默认宽度为 260px，并允许在 220–420px 之间拖动。这一设计可以保留。OpenCodex 实际 Sidebar 约 274px，二者差异不大。

真正需要统一的是 Sidebar 内部：

- 所有普通导航行统一为 32px；
- 图标统一 16px；
- 文本统一 13px；
- 分组标题使用 12px，不使用过低透明度；
- 时间、数量等元信息使用 12px；
- 当前会话使用弱背景或左侧状态点，不同时增加粗体、Accent、边框等多个信号。

## 六、色彩与卡片：保留科学品牌，减少内部浮层

Pi-Science 当前浅色主题：

```css
--bg: #faf9f5;
--surface: #ffffff;
--surface-2: #f0eee6;
--text: #262521;
--accent: #c96442;
```

暖米色背景、Source Serif 标题和陶土色 Accent 很适合科学研究产品，应继续保留。OpenCodex 的黑白极简更偏通用生产力工具，完全复制会削弱 Pi-Science 的辨识度。

建议只调整表面层级：

1. 主工作区使用更接近白色的 `surface`。
2. Sidebar 保留暖色 `bg`，自然形成主次分区。
3. 内部工具页面主要依靠背景差和弱边框，不默认添加阴影。
4. 项目首页可以继续使用卡片，因为项目本身是离散对象。
5. 对话、文件列表、Inspector 和设置行应更扁平，因为它们属于连续工作界面。
6. `shadow-card` 只用于真正浮起的 Popover 或 Dialog，不用于所有普通容器。

## 七、Composer 与空状态

Pi-Science 和 OpenCodex 的 Composer 宽度都接近 760px，现有宽度不需要大改。Pi-Science 的科学工作流快捷提示是有价值的产品差异，但应注意：

- 快捷提示只在空会话显示；
- 数量控制在 3–5 个；
- Composer 开始输入后及时隐藏；
- 快捷提示使用弱边框，不和主按钮竞争；
- 模型、推理强度、Review 等控件继续放在 Composer 工具行，但减少同时出现的分隔线和标签。

OpenCodex 的主要启发是让 Composer 成为页面唯一明显浮起的输入区域。Todo、Inspector 控件等不应再使用同等级阴影与它竞争。

## 八、不建议照搬的部分

### 不要照搬 OpenCodex Launcher 的视觉语言

OpenCodex Launcher 使用绿色 `#10A37F`、Outfit 字体、36px 按钮和偏传统的工具配置页。这是启动器的独立视觉，不是当前 Codex 主界面的设计体系，也不适合 Pi-Science。

### 不要立即改成全页面设置

OpenCodex/Codex 设置项数量远多于 Pi-Science，全页面和设置搜索是由信息规模决定的。Pi-Science 当前扩大 Modal 并重新分组即可；等一级设置页面显著增加后再迁移为独立路由。

### 不要复制全白、低品牌感界面

Pi-Science 的暖色和 Serif 标题已经构成明显产品特征。需要吸收的是层级、密度和交互克制，而不是抹掉品牌。

### 不要继续增加 Todo 模式

当前 Sticky/FAB 两套模式已经比 OpenCodex 的过程状态表达复杂。后续应做减法，而不是继续提供第三种位置或更多外观选项。

### 不要把所有信息都变成 Tab

Tab 适合需要频繁横向切换且状态需要保留的内容。临时文件预览、一次性运行结果、操作详情可以用预览标签、抽屉或对话内展开块，不应全部永久加入 Tab Strip。

## 九、推荐实施路线图

### 第一阶段：密度治理（P0）

目标：不改变信息架构，先让整个应用使用同一套控件语言。

1. 在 Tailwind theme 或 UI 基础组件中定义控件高度、字号和间距 token。
2. 普通正文不低于 13px，元信息不低于 12px。
3. 新增统一 `Icon`、`IconButton`、`NavRow` 和 `PanelHeader`。
4. 逐步清理 `text-[10px]`、`text-[11px]` 和重复的 arbitrary values。
5. 将 Sidebar 导航行统一为 32px。

### 第二阶段：Todo 收敛（P0）

1. 以 `TodoStickyBar` 为基础保留单一模式。
2. 删除拖动位置、FAB 和模式切换状态。
3. 改用 `完成数/总数`，移除百分比。
4. 完成后折叠保留，不立即消失。
5. 移动端展开列表使用底部 Sheet。

### 第三阶段：Inspector 标签扁平化（P0）

1. 标签栏改为 32px。
2. 删除垂直分隔线和多重选中信号。
3. 统一标签图标、关闭按钮和工具区。
4. 优化溢出导航。
5. 根据真实使用量决定是否增加预览标签。

### 第四阶段：设置页扩容（P1）

1. Modal 扩大到 900–960px。
2. 导航按“基础 / AI / 集成”分组。
3. 设置行统一为两列布局和 36×20px 开关。
4. 移动端改为两级全屏导航。
5. 设置项继续增长后再增加搜索。

### 第五阶段：表面层级整理（P1）

> 实施状态：已完成（2026-08-09）

1. 主工作区和 Sidebar 使用不同表面色。
2. 减少普通容器阴影。
3. 统一 Popover、Dialog 和 Card 的使用边界。
4. 保留项目首页卡片，扁平化连续工作界面。

实施结果：

- Sidebar 使用独立的 `--sidebar` 表面，主工作区继续使用 `--bg`；浅色与深色主题均有明确但克制的层级差。
- 普通 `ui-card`、`ui-card-flat` 和 `ui-card-inset` 默认无阴影；项目首页的 `ui-card-interactive` 保留卡片阴影与悬浮反馈。
- 浮动菜单、上下文菜单、Toast 和临时控制层统一使用 `ui-popover`；模态确认与设置窗口使用 `ui-dialog`。
- 对话、Research、Knowledge、Notebook、Files、Runs、Skills 与 Inspector 空状态中的连续容器已迁移为扁平 Card。
- 组件源码中的 `shadow-card` 使用已清零；阴影仅由项目卡、Popover 和 Dialog 的语义样式提供。

## 十、验收标准

### 视觉一致性

- 普通导航行只有一种高度；
- 标签、设置行、图标按钮使用共享尺寸；
- 除 Badge 外不存在 10px 普通文本；
- 同一状态不同时使用背景、边框、底线、粗体和 Accent 多重表达；
- 普通容器不再默认使用阴影。

### Todo

- 用户不需要选择 Todo 模式或管理其位置；
- 当前任务和完成数在一行内可见；
- 展开列表不遮挡 Composer；
- 完成状态可以回看；
- 移动端不存在与 Composer/Inspector 冲突的可拖动按钮。

### 标签页

- 1280px 宽度下至少能清晰容纳 3–4 个常见文件标签；
- active、hover、focus 和关闭状态可区分；
- 标签溢出后仍可通过键盘和可见控件访问；
- 最大化、关闭 Inspector 等工具不会挤压标签标题。

### 设置页

- 模型、计算和 MCP 设置在桌面端不因内容区过窄而频繁换行；
- 设置导航分组清晰；
- 移动端一级导航显示完整文字；
- Tab、Shift+Tab、Escape 和焦点恢复行为保持正常；
- 全局设置和工作区设置的作用域仍然明确。

## 相关源码索引

### Pi-Science

- `frontend/src/index.css`
- `frontend/tailwind.config.js`
- `frontend/src/app/layout/ProjectsLayout.tsx`
- `frontend/src/components/todo/TodoWidget.tsx`
- `frontend/src/components/todo/TodoStickyBar.tsx`
- `frontend/src/components/todo/TodoTaskRow.tsx`
- `frontend/src/components/inspector/InspectorTabs.tsx`
- `frontend/src/components/settings/SettingsDialog.tsx`
- `frontend/src/components/settings/SettingsContent.tsx`

### OpenCodex

- `../OpenCodex/web-shell/codex-smart-model-router-settings.css`
- `../OpenCodex/web-shell/codex-workspace-root-picker.css`
- `../OpenCodex/web-shell/codex-window-controls-overlay.css`
- `../OpenCodex/launcher/styles.css`
- `../OpenCodex/docs/image/home.jpg`
- `../OpenCodex/docs/image/new.jpg`
- `../OpenCodex/docs/image/settings.jpg`
