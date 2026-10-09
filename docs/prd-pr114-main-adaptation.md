# PR 114 适配主分支 PRD 与执行方案

日期：2026-10-09。状态：待实施。本文基于已拉取的 Git 提交和模拟合并结果。

## 1. 目标与实施结论

将 PR 114 的统一输入补全接入当前 `main`。用户在同一个候选菜单中完成命令、命令参数、子代理和工作区路径补全。

采用以下方案：保留 PR 114 的补全结构，合入当前主分支，再修复动态命令的过滤规则。保留主分支的 Agent Core 运行时和模型切换提示。

本次交付以输入行为正确为标准。清除 Git 冲突标记只是第一步。

必须完成以下结果：

1. `/compact`、`/export`、`/skill:名称` 和主分支的 prompt 命令都可查找。
2. 候选菜单与键盘使用同一个选中项。
3. 新会话能发现动态命令，并保留已经输入的内容和附件。
4. 补全发现和首次发送共用一次会话创建。
5. 工作区切换、会话切换和晚到请求不会污染当前会话。
6. 主分支的模型不可用提示、模型配置和消息发送行为继续有效。

## 2. 锁定分析基线

| 项目 | 精确值 |
|---|---|
| 仓库 | `https://github.com/Garhorne0813/pi-science.git` |
| PR | [PR 114](https://github.com/Garhorne0813/pi-science/pull/114) |
| PR 标题 | `feat(composer): unify composer completion behind Tab` |
| PR 分支 | `feat/composer-tab-completion` |
| PR 提交 | `0b726af679c9867de101743a19ee2b053c91d713` |
| 当前主分支提交 | `410e8daf601f330b8ce5f6c29ac0604858cd767c` |
| 共同祖先 | `4c15bb95f26ef3c9dd8d75b45410d7f4f0b2291a` |
| PR worktree | `/Users/cyq/.codex/worktrees/pr-114/pi-science` |
| 本文保存位置 | `/Users/cyq/codex/pi-science/docs/prd-pr114-main-adaptation.md` |

主分支提交 `410e8daf601f330b8ce5f6c29ac0604858cd767c` 已合入 PR 115。该 PR 将运行时迁移到 Agent Core。

PR 114 相对共同祖先修改 36 个文件。模拟合并只发现以下 2 个文本冲突：

- `frontend/src/lib/conversation/slash-commands.ts`
- `frontend/src/lib/conversation/slash-commands.test.ts`

模拟命令为：

```sh
git merge-tree --write-tree origin/main 0b726af679c9867de101743a19ee2b053c91d713
```

返回码 `1` 表示存在冲突。本次输出的合并树为 `340f7b51097cdaf36a6d3511edba5276187231f1`。该命令不修改工作区。

PR 描述引用 `docs/prd-composer-completion-ui.md`，但该文件不存在于 PR 提交中。本文重新定义适配要求。实施完成后，将实际提交的文档路径写入 PR 描述。

开始实施前重新获取主分支。若主分支 SHA 改变，重新运行模拟合并，并更新本节。不得把本节的冲突数量套用到新提交。

## 3. 范围

### 3.1 本次包含

- 保留 `frontend/src/lib/conversation/completion/` 的纯补全逻辑。
- 使用 `useComposerCompletion` 管理候选菜单和补全按键。
- 使用 `CompletionMenu` 显示唯一的补全菜单。
- 保留 `MentionComposer` 的文本框、光标和子代理标记处理。
- 将动态命令目录改为按工作区和会话隔离的 Query 缓存。
- 将主分支 prompt 命令纳入动态命令目录。
- 保留技能写入后的命令缓存失效处理。
- 验证 Agent Core 的命令发现和发送路径。

Query 缓存是按键保存请求结果的缓存。这里的键必须包含 `cwd` 和 `sessionId`。

### 3.2 本次不包含

- AI 续写、灰色预测文本和全文模糊搜索。
- 递归搜索工作区文件。
- 数据集、运行记录和产物的补全提供器。
- 给服务端新增结构化参数协议。
- 让 prompt 模板声明自动产生参数候选。
- 改写 Agent Core 的持久化、模型配置或任务调度。

主分支 `get_commands` 当前只返回名称、描述、来源和分组。`/export` 的 `html`、`jsonl` 候选由前端声明。不得把 `argumentHint` 解析成服务端不存在的参数协议。

## 4. 用户可见行为

### 4.1 命令来源与发送行为

| 来源 | 显示条件 | 前端分组 | 发送路径 |
|---|---|---|---|
| 内置 `compact` | 始终进入命令目录 | `session` | 现有 compact HTTP 接口 |
| 内置 `export` | 始终进入命令目录 | `utility` | 现有 export HTTP 接口 |
| `source === "skill"` | 名称以 `skill:` 开头 | `skill` | 现有 `sendPrompt`，服务端展开技能调用 |
| `source === "prompt"` | 服务端返回该命令 | `utility` | 现有 `sendPrompt`，服务端展开 prompt 模板 |
| `source === "extension"` | 不显示 | 无 | 保留未知斜杠文本的原有发送行为 |

内置命令优先。动态目录中的同名 `compact` 和 `export` 不得覆盖内置命令。

接受命令候选只修改输入。接受候选不得直接调用 compact、export 或 prompt 接口。保留 `immediate` 元数据时，也不得据此在补全阶段执行命令。

### 4.2 触发规则

| 输入例子 | 输入时打开菜单 | 行为 |
|---|---|---|
| `/ex` | 是 | 查找命令，接受后得到 `/export ` |
| `/skill:rev` | 是 | 查找当前运行时可用的技能 |
| `/sum` | 是 | 查找名称为 `summarize` 的 prompt 命令 |
| `/export ` | 否 | Tab 主动打开参数候选；Enter 使用原发送逻辑 |
| `/export j` | 是 | 显示 `jsonl` 候选 |
| `@` | 有子代理候选时打开 | 只列子代理，不列全部根目录文件 |
| `@rev` | 有匹配项时打开 | 子代理与根目录同前缀文件都能参与匹配 |
| `@data/pro` | 有匹配项时打开 | 匹配 `data` 目录内的文件前缀 |
| `data/pro` | 有匹配项时打开 | 补全文本中的工作区相对路径 |
| `protein` | 否 | 普通单词不自动打开文件菜单；Tab 主动请求补全 |
| 已完整输入唯一文件路径 | 否 | 无文本变化时不显示空操作候选 |

接受普通路径候选时，将路径写入文本。接受 `@文件` 或 `@目录` 候选时，移除该触发词并添加工作区引用卡片。

`@prot` 不搜索 `data/protein.csv`。用户输入 `@data/pro` 才会读取该目录。

### 4.3 按键规则

| 状态 | 按键 | 结果 |
|---|---|---|
| 菜单打开 | Tab 或 Enter | 接受当前选中项；不发送 |
| 菜单打开 | ArrowUp 或 ArrowDown | 修改当前选中项 |
| 菜单打开 | Escape | 关闭菜单，保留输入 |
| 菜单关闭，有候选 | Tab | 填充更长的共同前缀，或打开菜单 |
| 无可用候选 | Tab | 使用浏览器原有焦点移动 |
| 菜单关闭 | Enter | 使用现有发送逻辑 |
| 任意补全状态 | Shift+Enter | 使用原有换行行为 |
| 任意补全状态 | Shift+Tab | 使用浏览器原有反向焦点移动 |
| 中文输入法正在组词 | Tab、Enter 和方向键 | 交给输入法；不补全，不发送 |
| 焦点在其他控件 | 任意键 | 补全系统不处理 |

鼠标悬停的行必须成为当前选中项。随后按 Tab 或 Enter 必须接受该行。

Escape 的关闭决定只对当前触发词持续有效。用户继续输入同一词时保持关闭。用户替换触发词或按 Tab 后，菜单能重新打开。

## 5. 已确认的适配问题

| 编号 | 证据 | 直接影响 | 处理要求 |
|---|---|---|---|
| A1 | 主分支 `slash-commands.ts` 接收 `source === "prompt"`；PR 114 只接收 `skill:*` | 采用 PR 文件会隐藏 prompt 命令 | 合并来源过滤与分组逻辑 |
| A2 | 主分支测试要求 `summarize` 存在；PR 测试要求其不存在 | 测试契约互相冲突 | 保留主分支语义，迁移到新 Query API |
| A3 | 主分支向 `ModelControlMenu` 传入 `needsModelSwitch` | 整文件覆盖会丢失模型不可用提示 | 保留该属性，验证模型不可用场景 |
| A4 | PR 为动态发现提前创建空会话 | 草稿清空、重复会话和晚到创建结果成为关键风险 | 保留 PR 的草稿保留与连接代次检查 |
| A5 | 主分支技能接口先更新运行时，再返回成功 | 只刷新设置页会留下旧补全目录 | 保留两个技能入口的 `slash-commands` 缓存失效 |
| A6 | 主分支浏览器测试的 commands 模拟接口返回 `[]` | 原浏览器测试不能证明 prompt 命令兼容 | 给新增补全测试返回真实的 `{ commands: [...] }` 结构 |
| A7 | PR 引用的原 PRD 未提交 | 评审者无法读取行为契约 | 随适配代码提交本文并修正文档链接 |

主分支以下代码已确认：

- `apps/server/src/http/routes/node-session-routes.ts:244` 实现 `/api/sessions/:session_id/commands`。
- `apps/server/src/runtime/agent/worker/session-runtime.ts:361` 返回技能与 prompt 命令。
- `apps/server/src/runtime/agent/worker/session-runtime.ts:295` 在 prompt 发送时展开技能与 prompt 模板。
- `apps/server/src/http/routes/settings-routes.ts:858` 更新技能策略，并刷新运行时。
- `frontend/src/components/conversation/ConversationComposer.tsx:186` 保留 `needsModelSwitch` 传参。

以上行号对应第 2 节的主分支提交。

## 6. 逐文件实施方案

### 6.1 解决命令实现冲突

文件：`frontend/src/lib/conversation/slash-commands.ts`。

以 PR 114 的实现为结构基础，保留以下内容：

- `SlashArgumentSpec` 和 `/export` 参数声明。
- `slashCommandsQuery(cwd, sessionId)`。
- Query 键 `["slash-commands", cwd, sessionId]`。
- 请求的 `AbortSignal`。
- `allCommands(commands)` 的显式目录参数和内置命令去重。
- `commandTakesArguments`、`commandHint` 和分级匹配排序。

将 Query 中的过滤与映射改为以下代码：

```ts
.filter((command: SlashCommand) => (
	command.source === "prompt"
	|| (command.source === "skill" && command.name.startsWith("skill:"))
))
.map((command: SlashCommand): SlashCommand => ({
	name: command.name,
	description: command.description || "",
	argumentHint: command.argumentHint,
	arguments: command.arguments,
	source: command.source,
	group: command.source === "prompt" ? "utility" : "skill",
}));
```

显式返回类型限定 `group` 的取值。不要新增类型强制转换。

删除旧的全局 `dynamicCommands`、监听器和以下导出：

- `fetchDynamicCommands`
- `resetDynamicCommands`
- `subscribeDynamicCommands`
- `getDynamicCommandsSnapshot`

同步清除调用和测试引用。不得新增新旧 API 之间的兼容包装。

### 6.2 解决命令测试冲突

文件：`frontend/src/lib/conversation/slash-commands.test.ts`。

保留 PR 的 Query 测试结构。删除 `resetDynamicCommands` 的导入与清理。

将 `summarize` 的断言改为：

```ts
expect(allCommands(commands)).toContainEqual(expect.objectContaining({
	name: "summarize",
	group: "utility",
	source: "prompt",
}));
```

同时保留以下断言：

- `skill:review` 存在。
- `extension` 来源的 `deploy` 不存在。
- 内置 `compact` 只有一个。
- 名称前缀、名称包含、描述包含按该顺序排列。
- 同一级匹配保持原声明顺序。
- 不同工作区与不同会话的晚到响应只更新各自缓存。

补充 prompt 来源的跨会话隔离用例。让旧会话的响应晚于新会话返回，断言当前菜单不出现旧 prompt 命令。

### 6.3 保留主分支模型行为

文件：`frontend/src/components/conversation/ConversationComposer.tsx`。

保留自动合并后的补全接线与输入法状态。确认 `ModelControlMenu` 包含：

```tsx
needsModelSwitch={model.needsModelSwitch}
```

不要用 PR 版本整文件覆盖该组件。添加模型不可用的组件或路由测试。测试断言用户能看到切换提示，并且不能发送。

### 6.4 保留新会话发现并增加模型就绪检查

文件：`frontend/src/app/routes/LiveSessionPage.tsx`。

移除旧的动态命令加载 effect。命令目录由 `useComposerCompletion` 的 `useQuery` 订阅。

保留 PR 的空会话预创建入口，并增加主分支的模型就绪条件：

```tsx
useEffect(() => {
	if (!model.selectedModel || model.needsModelSwitch || model.configuringModel) return;
	const current = useRuntimeStore.getState();
	if (!sessionId && !activeSessionId && draft.startsWith("/") && current.cwd === workspaceCwd) {
		void createNewSession().catch(() => undefined);
	}
}, [
	activeSessionId,
	createNewSession,
	draft,
	model.configuringModel,
	model.needsModelSwitch,
	model.selectedModel,
	sessionId,
	workspaceCwd,
]);
```

上面的模型检查是本方案新增要求。PR 原实现没有该检查。

进入工作区或点击“新会话”时不创建会话。只有以 `/` 开头的草稿才触发动态命令发现所需的会话创建。未配置可用模型时，仍允许显示内置候选，不发出创建请求。

运行时创建成功后，首次普通 prompt 必须复用该会话。首次 prompt 成功后，沿用现有代码把 URL 更新到 `/session/:sessionId`。不得在动态发现时提前发送消息。

文件：`frontend/src/hooks/useComposer.ts`。

保留 PR 的 `adoptedDraft` 条件。只有相同 `cwd`、相同 `conversationKey` 且会话从 `null` 变为非空，才保留草稿。

切换工作区或切换真实会话时，继续清空旧输入、子代理标记、附件和工作区引用。

文件：`frontend/src/lib/agent-runtime/session-actions.ts`。

保留以下 PR 改动：

1. 创建去重键使用 `requestCwd` 与 `requestGeneration`。
2. 响应返回后检查工作区和连接代次。
3. 过期创建结果不接管当前会话，并尝试删除刚创建的空会话。
4. 过期请求的错误不写入新会话。
5. `finally` 只删除属于当前 Promise 的去重记录。

连接代次是当前连接的序号。切换连接后，旧序号的请求不能修改当前状态。

### 6.5 保留缓存失效和文件缓存共享

文件：

- `frontend/src/components/settings/SkillsTab.tsx`
- `frontend/src/lib/skills/skills-mutations.ts`
- `frontend/src/lib/workspace/workspace-files.ts`

保留两个技能入口的：

```ts
void queryClient.invalidateQueries({ queryKey: ["slash-commands"] });
```

该调用放在服务端操作成功之后。失败时显示原有错误，不把本地候选伪装成已更新。

保留 `workspaceFilesQuery(cwd, subdir)`。补全和侧栏使用同一目录缓存。不新增独立文件列表缓存。

### 6.6 保留纯逻辑与统一菜单

以下文件按 PR 114 保留，再运行回归测试：

- `frontend/src/lib/conversation/completion/types.ts`
- `frontend/src/lib/conversation/completion/token.ts`
- `frontend/src/lib/conversation/completion/engine.ts`
- `frontend/src/lib/conversation/completion/registry.ts`
- `frontend/src/lib/conversation/completion/index.ts`
- `frontend/src/lib/conversation/completion/slash-provider.ts`
- `frontend/src/lib/conversation/completion/slash-argument-provider.ts`
- `frontend/src/lib/conversation/completion/mention-provider.ts`
- `frontend/src/lib/conversation/completion/path-provider.ts`
- `frontend/src/hooks/useComposerCompletion.ts`
- `frontend/src/components/conversation/CompletionMenu.tsx`
- `frontend/src/components/conversation/MentionComposer.tsx`

提供器是某一类候选的检测与生成逻辑。注册顺序保持为 `slash-argument`、`slash`、`mention`、`path`。只运行第一个接受当前光标位置的提供器。

纯逻辑不导入 React，不发送 HTTP 请求。Hook 负责取数据。组件负责显示和写回输入。

删除 `frontend/src/components/SlashCommandMenu.tsx` 与对应测试。不得恢复全局 `document.keydown` 补全处理。

保留 `frontend/src/i18n/locales/en.json` 与 `frontend/src/i18n/locales/zh-Hans.json` 的补全文案。菜单使用 `combobox`、`listbox`、`option` 语义。

### 6.7 验证服务端契约

本方案不要求修改服务端生产代码。使用主分支现有的以下路径：

- `GET /api/sessions/:session_id/commands?cwd=...`
- 现有 prompt、compact 和 export 接口。
- 现有技能设置与刷新接口。

在 `apps/server/src/runtime/agent/worker/session-runtime.test.ts` 中补充命令目录用例。在 `apps/server/src/runtime/agent/agent-core-turns.test.ts` 中补充 prompt 模板和技能调用的发送用例。若现有测试已覆盖同一行为，复用现有用例并记录测试名称。

测试必须证明以下行为：

1. `get_commands` 返回允许使用的 `skill:*` 和已加载的 prompt 模板。
2. 禁用技能后，该技能从目录移除；调用被禁用技能返回 `unknown_skill`。
3. `/summarize text` 在服务端展开为模板消息。
4. 前端补全接受候选时没有发送 prompt。
5. 未知普通斜杠文本仍通过原发送路径处理。

## 7. 验收用例

以下用例均为发布条件。测试数据使用 `summarize` prompt、`review` 技能、`reviewer` 子代理和 `data/protein.csv` 文件。

| ID | 操作 | 必须观察到的结果 | 测试位置 |
|---|---|---|---|
| AC-01 | 输入 `/sum`，按 Tab | 得到 `/summarize`；尚未发送 | `ComposerCompletion.test.tsx` |
| AC-02 | 接受 `summarize` 后输入参数并发送 | 沿用 `sendPrompt`；服务端展开模板 | 路由测试与 Agent Core 测试 |
| AC-03 | 输入 `/skill:rev`，按 Tab | 接受 `skill:review`；尚未发送 | `ComposerCompletion.test.tsx` |
| AC-04 | 输入 `/ex`，连续按两次 Enter | 第一次得到 `/export `；第二次执行 export | 组件测试与路由测试 |
| AC-05 | 输入 `/export `，按 Tab、ArrowDown、Enter | 接受 `jsonl`；仍未发送 | `ComposerCompletion.test.tsx` |
| AC-06 | 输入 `/export j`，按 Enter | 接受 `jsonl`；再次 Enter 才执行 export | 组件测试与路由测试 |
| AC-07 | 输入 `data/pro`，按 Tab | 得到 `data/protein.csv` | 路径提供器与组件测试 |
| AC-08 | 两个文件共有前缀，菜单关闭时按 Tab | 先填共同前缀；菜单显示可选行 | 引擎与组件测试 |
| AC-09 | 输入普通单词 `protein` | 不自动打开文件菜单；Enter 正常发送 | `ComposerCompletion.test.tsx` |
| AC-10 | 输入 `@rev`，悬停 `reviewer` 后按 Tab | 接受悬停项并建立子代理标记 | `ComposerCompletion.test.tsx` |
| AC-11 | 输入 `@data/pro` 并接受文件 | 添加引用卡片，删除触发词 | `ComposerCompletion.test.tsx` |
| AC-12 | 按 Escape，再继续同一触发词，最后按 Tab | 保留文本；先保持关闭；Tab 能重新打开 | `ComposerCompletion.test.tsx` |
| AC-13 | 使用中文输入法，按 Enter 确认组词 | 不补全，不发送；组词结束后恢复 | 路由测试与真实浏览器 |
| AC-14 | 工作区无会话，输入 `/skill:rev` | 只创建一个会话；草稿和已有附件、引用保留 | 路由、运行时和草稿测试 |
| AC-15 | 创建会话尚未返回时立即首次发送 | 发现与发送共用一次创建；发送不重复 | `session-actions.test.ts` |
| AC-16 | 创建请求期间切换到同工作区的另一会话 | 旧结果不替换新会话；尝试清理旧空会话 | `session-actions.test.ts` |
| AC-17 | 切换工作区，旧 commands 响应晚到 | 当前菜单不显示旧工作区命令 | Query 与组件测试 |
| AC-18 | 切换会话，旧 prompt 目录晚到 | 当前菜单不显示旧会话 prompt 命令 | Query 与组件测试 |
| AC-19 | 禁用 `review` 技能，返回会话输入 `/skill:` | `skill:review` 消失；prompt 命令仍存在 | 技能刷新与路由测试 |
| AC-20 | 未配置模型或模型不可用时输入 `/` | 不创建会话；内置补全可用；发送禁用 | `LiveSessionPage.test.tsx` |
| AC-21 | 文件接口失败或命令接口失败 | 输入仍可编辑；菜单无候选时不吞按键 | 组件测试 |
| AC-22 | 焦点移到设置控件，按 Tab 或 Enter | 补全系统不处理这些按键 | 组件测试与浏览器 |
| AC-23 | 在 375 像素宽度和明暗主题打开菜单 | 无横向溢出；长名称截断；选中项可读 | 浏览器测试 |
| AC-24 | 菜单打开时运行可访问性检查 | 无 serious 或 critical 问题 | Playwright 与 axe-core |

## 8. 按顺序执行

### 8.1 建立适配分支并合入主分支

在已创建的 PR worktree 中执行。该 worktree 当前是干净的 detached HEAD。若 `git status` 显示已有改动，先保存这些改动，不执行覆盖或清理命令。

```sh
cd /Users/cyq/.codex/worktrees/pr-114/pi-science
git status --short --branch
git fetch origin main
git rev-parse origin/main
git switch -c codex/pr-114-main-adaptation 0b726af679c9867de101743a19ee2b053c91d713
git merge --no-commit --no-ff origin/main
```

这是实施命令，本文编写期间未执行该合并。

基线未变化时，最后一条命令在第 2 节的 2 个文件报告冲突。按第 6.1 节与第 6.2 节解决。其余自动合并文件仍按第 6 节核查。

需要放弃尚未完成的合并时，在该 worktree 执行 `git merge --abort`。

### 8.2 完成冲突与生命周期改动

1. 修改 `slash-commands.ts` 的来源过滤和分组。
2. 迁移 `slash-commands.test.ts`，保留 prompt 命令断言。
3. 检查 `ConversationComposer.tsx` 的 `needsModelSwitch`。
4. 给新会话发现 effect 增加模型就绪检查。
5. 保留草稿接管、创建去重和过期响应检查。
6. 保留技能缓存失效与统一菜单。

标记冲突已解决：

```sh
git add frontend/src/lib/conversation/slash-commands.ts frontend/src/lib/conversation/slash-commands.test.ts
git diff --name-only --diff-filter=U
rg -n '^(<<<<<<< |=======|>>>>>>> )' frontend/src
rg -n 'fetchDynamicCommands|resetDynamicCommands|subscribeDynamicCommands|getDynamicCommandsSnapshot|SlashCommandMenu' frontend/src
git diff --check
git diff --cached --check
```

前 3 项检查必须没有冲突文件或遗留符号。`rg` 没有匹配时返回 `1`，这是预期结果。

### 8.3 补充测试并检查前端

安装依赖时使用合并后的主分支锁文件。主分支要求 Node.js `>=24.16.0` 和 pnpm `11.7.0`。不得复制当前另一工作区的 `node_modules` 作为验收环境。

```sh
pnpm install --frozen-lockfile
pnpm --filter frontend exec vitest run src/lib/conversation/slash-commands.test.ts src/lib/conversation/completion src/components/conversation/ComposerCompletion.test.tsx src/components/conversation/CompletionMenu.test.tsx src/components/conversation/MentionComposer.test.tsx
pnpm --filter frontend exec vitest run src/lib/agent-runtime/session-actions.test.ts src/hooks/useComposer.test.tsx src/hooks/useComposer.initialDraft.test.tsx src/app/routes/LiveSessionPage.test.tsx src/app/routes/LiveSessionPage.stale-slot.test.tsx src/app/routes/review-status.test.tsx
pnpm --filter frontend lint
pnpm typecheck
```

在路由测试中增加 `source: "prompt"` 目录、无模型的 `/` 输入、附件保留和技能更新场景。不要只修改断言来消除错误。

### 8.4 运行服务端和完整回归

```sh
pnpm --filter @pi-science/server exec vitest run src/runtime/agent/worker/session-runtime.test.ts src/runtime/agent/agent-core-turns.test.ts src/runtime/agent/agent-core-session-service.test.ts src/http/routes/node-session-routes.test.ts
pnpm test
pnpm build
pnpm --filter frontend test:bundle
pnpm smoke
```

Windows CI 沿用主分支的服务端文件串行执行方式。不要恢复旧的 `smoke:real-pi`。需要真实 Agent Core 流程验证时，执行主分支已有的 `pnpm smoke:agent-core`，并先满足该脚本的模型配置要求。

### 8.5 补充浏览器验证

新增文件 `frontend/tests/visual/composer-completion.spec.ts`。复用 `frontend/tests/visual/fixtures/app.fixture.ts` 和 `frontend/playwright.visual.config.ts`。

为该测试通过 `page.route` 返回固定数据。这样无需改变其他视觉测试的截图基线。模拟响应必须使用以下结构：

```json
{
  "commands": [
    { "name": "skill:review", "description": "Review files", "source": "skill", "group": "skill" },
    { "name": "summarize", "description": "Summarize text", "source": "prompt", "group": "utility" }
  ]
}
```

同时模拟子代理发现和分目录文件请求。使用 `/api/files` 的数组响应及 `/api/files/breadcrumbs` 的数组响应。不得将全部目录扁平混在一次文件响应中。

测试通过真实 `fill`、`press`、`hover` 操作完成 AC-01、AC-05、AC-07、AC-10、AC-22、AC-23。统计 prompt 请求数量，接受候选时数量必须为 `0`。增加菜单打开状态的 axe-core 检查，并标记 `@accessibility`。

```sh
pnpm --filter frontend test:visual:typecheck
pnpm --filter frontend exec playwright test --config playwright.visual.config.ts composer-completion.spec.ts --project desktop-light --project desktop-dark --project mobile
pnpm --filter frontend test:accessibility
```

真实输入法事件需要在浏览器手动验证 AC-13。合成事件单测不能替代该检查。

最后在真实服务端运行 `pnpm uat:conversation`。该脚本要求服务端、前端和浏览器可执行文件就绪。它默认使用 `http://127.0.0.1:8787` 与 `http://127.0.0.1:5173`。存在可用模型时验证真实发送路径；无可用模型时的 SKIP 不能作为真实发送通过证据。

### 8.6 提交和评审

1. 将本文复制到适配分支的 `docs/prd-pr114-main-adaptation.md`。
2. 检查暂存区只包含 PR 114、主分支合并、适配修复和必要测试。
3. 保留主分支的 `package.json`、`pnpm-lock.yaml` 和 Agent Core 生产代码。
4. 完成合并提交，再提交新增测试或适配修复。提交前检查工作区，避免遗漏未暂存文件。
5. 更新 PR 描述，写明 prompt 命令兼容、模型提示保留和本次真实验证结果。
6. 用 PR 实际提交的文档替换失效的原 PRD 链接。

方案选择 merge 更新适配分支，不改写现有 PR 的 12 个提交。发布时记录最终主分支 SHA 和最终 PR SHA。

需要将已验收的适配提交更新到原 PR 114 时，使用普通推送。先获取远程 PR 分支，确认它仍是本地提交的祖先：

```sh
git fetch origin refs/heads/feat/composer-tab-completion:refs/remotes/origin/feat/composer-tab-completion
git merge-base --is-ancestor origin/feat/composer-tab-completion HEAD
git push origin HEAD:feat/composer-tab-completion
```

只有祖先检查返回 `0`，才执行最后一条命令。若检查失败，说明原 PR 已收到其他提交。先合入这些提交，再重新验收。不得使用 `--force` 或 `--force-with-lease` 覆盖远程变更。

以上推送属于实施后的发布步骤。本文编写期间没有推送代码或修改远程 PR。

## 9. 发布条件与回退

以下条件全部满足后，才合入主分支：

- AC-01 至 AC-24 均有测试结果或明确的人工验收记录。
- 所有冲突已解决，旧菜单和旧全局命令 API 无引用。
- `pnpm typecheck`、前端 lint、完整测试、构建和 bundle 检查通过。
- Ubuntu 与 Windows 的主分支质量检查通过。
- 浏览器验证证明 prompt 命令可见，补全不直接发送。
- 真实输入法验收通过。
- 本次验证结果对应最终待合并提交。

测试记录写入 `docs/pr114-main-adaptation-validation.md`。记录命令、提交 SHA、退出码、失败原因和人工验收结果。该文件在实施阶段创建。

PR 描述中的旧测试结果只说明旧基线状态。不得将其复制为当前 Agent Core 基线的验证结果。任何测试失败都需要在相同基线复现并分类，不能直接标记为历史问题。

本次不涉及存储格式和数据迁移。上线后若出现补全吞按键、草稿丢失或 prompt 命令消失，停止发布并回退适配 PR。使用最终实际合入主分支的合并提交做 revert，保留之后其他 PR 的变更。回退前记录该真实提交 SHA，不对主分支执行 hard reset 或强制推送。

## 10. 本次文档工作的验证范围

已完成：

- 获取最新主分支和 PR 114，并确认提交 SHA。
- 比较两侧代码与测试。
- 使用 `git merge-tree` 确认实际文本冲突。
- 确认 Agent Core 的命令发现、模板展开和技能刷新路径。
- 核查文档中的现有脚本、现有测试路径和新增任务。

尚未执行：

- 实际合并与代码修改。
- 适配后的 typecheck、测试、构建和浏览器验收。

本文交付的是实施方案。第 8 节的命令和第 7 节的验收结果必须由实施阶段完成。
