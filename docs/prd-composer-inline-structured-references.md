# PRD｜Composer 行内结构化引用（pi-science）

> 版本：1.1 · 日期：2026-10-09 · 状态：实现分支 / 待 CI 与产品验收
> 
> 基线：`main@10ff1f6b720f6a7b912a6807ea50d5e1b296b8f9`
> 
> 来源：用户提供的 *Composer Inline Structured References* PRD（2026-10-01）；本版结合 `main` 的实际代码核对并补充设计决策。此文档不宣称所有增强项已完成。

## 一、执行摘要

### 1.1 产品目标

用户可以在自然语言提示词的**语义位置**插入 `@文件`、`@目录`、`@子代理` 等引用。UI 显示可读令牌；内部保存独立的引用身份；删除令牌必须删除对应绑定，避免“文字消失但后台仍传文件”的错配。

示例：

```text
用 @config.yaml 处理 @data/protein.csv，再和 @results/control.csv 比较。
请 @reviewer 检查活性位点附近的结构变化。
```

### 1.2 主分支现状（已核对）

| 模块 | 主分支行为 | 本次处理 |
| --- | --- | --- |
| `MentionComposer.tsx` | textarea + mirror 高亮，`mentions[]` 只保存子代理 | 扩展渲染/原子编辑为统一 `entities[]` |
| `mention-provider.ts` | 接受 `@文件` 后删除输入令牌，转为顶部独立引用 | 改为保留 `@工作区相对路径` 并生成引用实体 |
| `useComposer.ts` | 子代理本地数组、工作区引用 Zustand 数组分别管理 | 行内引用从 `entities[]` 派生；保留顶部旧入口兼容 |
| `file-references.ts` | 发送时追加 `<workspace_references>` 元数据段 | 保留协议，去重合并两种来源 |
| `subagent-mentions.ts` | 发送时追加 `<subagent_mentions>` 元数据段 | 保留现有协议及子代理行为 |

### 1.3 成功标准（建议验收门槛）

1. 正确显示和引用至少 100 个非重叠行内实体（性能预算：本地变更典型 <8ms，待测）。
2. 引用被移除后，待发送的 `<workspace_references>` 中不存在该引用。
3. 重复引用在文字里按出现次数保留，而工作区加载列表按 `cwd+path` 去重。
4. 输入法、连续撤销/重做、复制粘贴与长文本场景无阻塞或静默重绑定。
5. 不引入富文本编辑器新依赖，不改变旧消息协议的基本结构。

## 二、问题与用户场景

- **语义丢失**：外挂附件仅能说明“引用了什么”，不能定位“在哪句话引用”。
- **引用歧义**：裸文本 `@protein.csv` 无法区分同名文件、工作区或目录。
- **孤儿绑定**：删除视觉标签与删除提交元数据可能不同步。
- **科学任务依赖**：多文件比较、蛋白 WT/突变体、数据集、计算结果及子代理协作需要可追溯定位。

典型流程：
1. 键入 `比较 @WT`，从候选中选中 `WT.pdb`。
2. 继续键入 `和 @mut`，选中 `mutant.pdb`。
3. 两者在原句中高亮，并各有独立的实体 ID、range、引用元数据。
4. 按 Backspace/Delete 整体删去一个引用，消息发送仅包含剩余引用。
5. 同一文件可重复引用两次，文字不折叠，加载去重。

## 三、功能范围与优先级

| ID | 优先级 | 功能 | 本分支范围/状态 |
| --- | --- | --- | --- |
| F-01 | P0 | `ComposerDocument { value, entities }` 和判别联合实体 | 已编码，待验证 |
| F-02 | P0 | `@文件/目录` 补全后保留行内令牌 | 已编码，待验证 |
| F-03 | P0 | 镜像层宽度中性高亮；原生 textarea 控制选择和 IME | 已编码，待视觉验证 |
| F-04 | P0 | 光标边界吸附、选择扩展、Backspace/Delete 原子操作 | 已编码，待跨浏览器验证 |
| F-05 | P0 | 编辑前缀修正 offset；交叉编辑解除结构绑定 | 已编码，待边界测试 |
| F-06 | P0 | 发送前按 `cwd+path` 去重；保留既有消息协议 | 已编码，待集成测试 |
| F-07 | P0 | 顶部已有附件/引用入口兼容、切换会话和失败重试恢复 | 已编码，待完整回归 |
| F-08 | P0 | 单元/集成/IME/剪贴板/可访问性测试 | 部分新增，未完成完整矩阵 |
| F-09 | P1 | 发送前文件存在性/权限校验；失效引用警告和替换 | 待实现 |
| F-10 | P1 | 与撤销/重做同步的实体历史事务 | 待验证；必要时实现 |
| F-11 | P1 | 相同 basename 的路径消歧与重命名/移动追踪 | 待实现 |
| F-12 | P1 | 结构化应用内复制粘贴（自定义 MIME） | 暂不做 |
| F-13 | P2 | dataset、run、artifact、外部资料同一基础契约 | 仅预留模型扩展方向 |
| F-14 | P2 | 富编辑器评估（Lexical/Tiptap 等） | 不属于本期 |

不做：富文本样式、可点关闭按钮的宽芯片、拖动实体、嵌套节点、协同编辑、从粘贴纯文本自动推断文件身份。

## 四、信息架构与数据契约

```ts
interface ComposerDocument {
  value: string; // textarea 真实可读值
  entities: ComposerEntity[]; // 唯一行内绑定来源
}

type ComposerEntity =
  | { kind: "mention"; id: string; start: number; end: number; name: string }
  | { kind: "reference"; id: string; start: number; end: number;
      reference: { cwd: string; path: string; name: string; isDir: boolean } };
```

- 区间使用 `[start,end)`，偏移单位为 JavaScript UTF-16 code units，与 textarea selection API 一致。
- 插入文本规范：`@<workspace-relative-path>`。结尾自动空格不属于实体范围。
- `id` 标识**单次出现**，`cwd+path` 标识当前版本的工作区对象查找键。该键不是跨重命名的永久 ID。
- 仅 `entities[]` 决定行内引用；顶部历史引用存储仍作为兼容输入，在发送时与行内引用合并，避免破坏其他入口。
- 实体元数据损坏、越界、重叠或文本与期望令牌不一致时：**丢弃绑定，不丢文本，不从裸 `@name` 自动重新解析**。

### 4.1 编辑契约

| 事件 | 行为 |
| --- | --- |
| 普通输入在引用前 | 后续 range 按字符差量整体平移 |
| 在引用内部输入或删一部分 | 影响到的整个引用被移除；插入文本保留在修复后的文本中 |
| 引用结尾 Backspace | 删除整个引用；移除绑定 |
| 引用开头 Delete | 删除整个引用；移除绑定 |
| 光标落在实体内部 | 靠近左侧吸左边界，靠近右侧吸右边界 |
| 跨实体选择 | 选区端点向外扩展至完整边界 |
| 复制或剪切 | 标准纯文本剪贴板，剪切同步清理实体 |
| 从外部粘贴裸 `@path` | 只产生文本，不创建绑定 |
| IME 组合期间 | 不做光标吸附，不消费 IME 键；组合完成后同步修复 |

### 4.2 发送契约与兼容

文字仍由 `sendPrompt(string)` 发送；将 deduplicated 引用继续放在已有 `<workspace_references>` 块中，子代理仍放在已有 `<subagent_mentions>` 块中。UI 展示仍使用过滤后的纯文字。例：

```text
Compare @WT.pdb with @mutant.pdb near residue 42.

<workspace_references>
- file: "WT.pdb"
- file: "mutant.pdb"
</workspace_references>
```

约束：只按实体元数据处理引用；显示文本不是安全的身份解析依据。文件内容读取与权限检查仍由现有服务端安全边界承担。

## 五、界面规范与交互

- 使用原生 textarea 承担键盘、光标、选区、IME、无障碍语义。
- mirror 使用 `aria-hidden`，只绘制行内背景、文字色和 inset ring；不得加入额外水平 padding、图标或关闭按钮。
- 保留顶部传统上传文件卡片与外部选择产生的工作区引用卡片；用户通过 `@` 新选的行内实体不重复出现在顶部。
- 引用异常不得被静默替换为同名其他文件；P1 需要可见警告和可访问错误信息。
- 禁止把完整提示词和绝对路径写入一般产品埋点。

## 六、关键风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| textarea diff 范围歧义（重复字符、替换操作） | range 可能漂移 | 所有编辑走统一变换；覆盖选择、撤销与 CJK 用例 |
| 原生 undo/redo 与应用层实体状态未形成同一事务 | 文本恢复但绑定不恢复 | 本期严格回归；P1 必要时引入事务历史 |
| 行内镜像与光标几何不等宽 | 点击、选区位置错位 | 保持 width-neutral 装饰并增加长路径/窄窗口视觉测试 |
| 路径重命名/跨工作区变化 | 引用丢失或指错 | 不按显示名重绑定；增加稳定对象 ID 或版本戳与发送校验 |
| 旧 `<workspace_references>` 封装为文本 | 非结构化传输与分隔符注入风险 | 后续演进显式 DTO；服务端需验证路径范围与解析 |
| 在异步发送期间切换会话 | 失败重试可能恢复到错误会话 | 保留现有会话关联守卫并补充回归 |
| 文件已删除或读取权限变化 | 无效引用落入模型上下文 | P1 发送前检查，显式警告与替换 |

## 七、验收矩阵

### 7.1 必须通过（P0）

- 空输入、中间、句首/末、标点、新行、长目录、多层路径插入。
- 重复文件引用和多个不同类型实体；同一对象出现两次但加载一次。
- 更改实体前后文字、删除实体前后字符、Backspace/Delete、跨实体选区、鼠标两半区域。
- 清空输入、切换会话、首条消息建立会话、失败恢复后重发；历史顶部引用保持兼容。
- 中文拼音/日文/韩文 IME 组合（含组合取消、Enter 确认）、复制/剪切/粘贴、连续 undo/redo。
- 屏幕阅读器能听到可读字符串；mirror `aria-hidden`；键盘导航无阻碍。
- 针对 100 个引用与长文本测量典型编辑响应、滚动和视觉同步。

### 7.2 数据断言

```text
输入: "用 @a.csv 对比 @a.csv 和 @b.csv"
实体 occurrence: 3
序列化唯一工作区引用: 2
删除第二个 @a.csv 后 occurrence: 2，序列化仍为 2
删除两个 @a.csv 后序列化只剩 b.csv
粘贴 "@secret.csv" 不创建任何新的 reference entity
```

## 八、发布步骤

- **A／基础模型**：统一实体、合法性校验与编辑算法，添加单元测试。
- **B／行内交互**：补全插入、mirror、光标与原子删除、序列化兼容，完成回归。
- **C／质量加固**：补充 IME/Clipboard/Undo/长文本/窄视口测试，CI 全绿后灰度。
- **D／下一期**：文件存在性与稳定身份、结构化剪贴板、dataset/run/artifact。

发布前应运行 `pnpm --filter frontend typecheck`、`pnpm --filter frontend test`，并运行视觉/可访问性脚本及仓库根目录集成测试。创建 PR 本身不能等同于这些验证通过。

## 九、开放决策（需要明确负责人）

1. 文件被重命名、移动或覆盖后，允许原引用继续指向路径，还是必须绑定稳定的工作区对象 ID？
2. 失效引用是阻止发送，还是允许带显式警告发送？推荐：对不能安全读取的引用阻止静默发送。
3. 目录的范围、递归深度和权限校验边界如何定义？
4. 提交时引用是否升级为结构化 API DTO，同时保留历史消息解析？
5. 何时需要带图标、大小、关闭按钮的丰富芯片，进而迁移真正的富编辑器？

## 十、相关代码与追踪

- `frontend/src/lib/conversation/composer-document.ts`：行内实体及编辑转换。
- `frontend/src/components/conversation/MentionComposer.tsx`：textarea/mirror、原子编辑。
- `frontend/src/lib/conversation/completion/mention-provider.ts`：插入可读 `@path`。
- `frontend/src/hooks/useComposer.ts`：消息生成与兼容。
- `frontend/src/components/conversation/ConversationComposer.tsx`：状态接入。
- `frontend/src/lib/files/file-references.ts`：旧传输协议。

**结论**：P0 的设计重心是“让结构化对象与句子位置绑定”，而不是追求富文本芯片的外观。若 CI 或上述必验测试未完成，本分支只能视为实现候选，不能宣布正式可用。
