# Inspector 预览设计统一

本次改造沿用工作台已有的 surface、border、accent、文字与控件 Token。Markdown 新增 `inspector` 变体，保留聊天 `chat` 和独立阅读 `document` 的兼容性。

## 布局与状态

- Tab 栏中的「展开工作区 / 恢复分栏」使用布局图标；文件工具栏中的「专注查看 / 退出专注」使用 Maximize2 / Minimize2。
- `RightPane` 在展开与分栏之间保持同一 DOM 结构，预览不重新挂载。访问过的 Tab 保持挂载，保留草稿、滚动、字号和 Viewer 内部状态。
- 专注查看复用当前内容实例，支持 Esc、键盘焦点约束与退出后的焦点恢复。移动端使用现有可关闭全屏预览，隐藏额外专注入口。
- Mol* 尺寸变化只执行 resize，不重新适配相机；Three.js 保留既有相机和 OrbitControls。Genome 在 contig 初始化后绑定尺寸观察器，避免窄栏仍按默认 760px 绘制。

## 内容适配

- Markdown 和源码在文件工具栏调整字号，支持 Ctrl / Command + 滚轮；字号状态属于当前预览实例。
- 图片提供适应窗口、原始尺寸、倍率与滚动平移。图片倍率独立于文档字号和文件专注。
- FITS 提供自己的适应窗口、原始尺寸和倍率；科学色图、拉伸、底部原点像素与 WCS 换算保持原有语义。
- Canvas、WebGL、SVG、Office、HTML、PDF 和视频不使用通用 CSS zoom；HTML sandbox、PDF 嵌入和 Office Shadow DOM 保持原有边界。
- `ViewerToolbar` / `ViewerStatusBar` 与 `preview-toolbar` / `preview-status` 仅共享外壳，不承载领域逻辑。科学画布保留独立背景、色图与单位。
- CSV/TSV 采用数值列右对齐、等宽数字、固定表头、行 hover 和明显截断提示；XLSX 保留源单元格格式。

## 验证

组件测试覆盖预览模式、焦点与状态保留、展开不重新挂载、字号恢复、科学缩放降级、图片适配、FITS 像素命中、Genome 尺寸观察和表格截断。

`frontend/tests/visual/inspector.visual.spec.ts` 覆盖 Markdown、专注查看、移动预览，以及代码、表格、图片、Mol*、Mesh、FITS、Genome 的明暗主题和窄屏截图。科学预览还验证进出专注模式后绘图节点保持原实例。

常规验证入口：前端 `typecheck`、`build`、`test`、`lint`，以及 `playwright test --config playwright.visual.config.ts inspector.visual.spec.ts`。Office 和 Notebook 继续由已有组件测试覆盖；浏览器新增截图主要覆盖上述代表性普通文件和科学格式。

## Review 修复：缩放边界与 iframe 键盘焦点

图片采用独立于文档字号的倍率范围；范围包含 Fit 倍率及其上下各 16 倍余量，并保留 resize 后已有手动倍率，避免从 Fit 切换到手动缩放时跳变或方向反转。普通图片仍默认适应窗口且不放大超过原尺寸；FITS 允许适应窗口时放大科学像素。

专注模式为可访问的同源 iframe 绑定 Esc 监听，覆盖延迟加载与导航，并在退出时解绑。不注入页面脚本，也不调整 iframe sandbox。嵌入页面已消费的 Esc 或内部对话框由页面自身处理。浏览器原生 PDF 和不可访问的跨域页面不能保证向父页面转发键盘事件，工具栏的“退出专注”始终保留，并在专注预览中显示限制说明。

回归测试覆盖 10000/1000000 像素图片按钮与 Ctrl/Command 滚轮、2×2 FITS 从 Fit 状态直接放大/缩小、iframe 延迟加载及监听清理，并在真实浏览器中验证 HTML 内输入框获焦后的 Esc 退出与原生 PDF 内获焦后的外部退出操作。

## 第二轮 Review：纯键盘导航与事件批处理

专注模式将可聚焦 iframe 纳入 Tab 顺序，并在入口显式交接焦点；可访问 iframe 内的首尾控件与父工具栏之间也有明确的边界转移。通过背景 inert 和父页面 focusin 约束，防止焦点回到背景控件。可访问的 iframe 记录 Tab 方向，支持正向与反向导航；退出时清理监听并恢复原焦点。

iframe 内原生 `<dialog>` 与 ARIA 对话框优先处理 Esc：`showModal()` 弹窗先关闭，文件专注保持开启，下一次 Esc 再退出文件专注。图片 Ctrl/Command 滚轮使用函数式状态更新，连续事件在 React 批处理期间仍按累计倍率计算。

浏览器测试使用纯 Tab/Shift+Tab 进入 HTML/PDF，遍历边界检查背景焦点约束，并用 Enter 打开原生 dialog 验证两层 Esc 顺序；组件测试覆盖同批次连续滚轮和焦点监听清理。
