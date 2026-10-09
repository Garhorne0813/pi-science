# PR 114 适配主分支验证记录

日期：2026-10-09。对应 PRD：`docs/prd-pr114-main-adaptation.md`。

本文记录实施阶段的真实结果。所有结论都来自本次会话的命令输出或浏览器证据；未验证项单独列出。

## 1. 提交

| SHA | 说明 |
|---|---|
| `b3bfeb5e` | Merge origin/main (`410e8daf`) into `feat/composer-tab-completion`。解决 `slash-commands.ts` 与 `slash-commands.test.ts` 两个冲突。 |
| `374c07ad` | fix(composer)：只有在本工作区输入的草稿才触发命令发现。 |
| `456fe6f9` | fix(runtime)：晚到的创建结果不再写入用户已经切走的会话。 |
| `2aeadc9d` | test(composer)：命令目录、技能刷新和浏览器验收用例。 |
| 本文提交 | docs：PRD 与验证记录。 |

合并前 PR 提交为 `0b726af6`。基线主分支为 `410e8daf`。

## 2. 自动验证

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | 复用缓存，1.6 秒 |
| `pnpm --filter frontend lint` | 0 | oxlint 无告警 |
| `pnpm build` | 0 | contracts、server、frontend 全部构建成功 |
| `pnpm --filter frontend test:bundle` | 0 | 体积预算通过 |
| `pnpm --filter frontend test:visual:typecheck` | 0 | 视觉测试类型检查通过 |
| `pnpm smoke` | 0 | 控制面 smoke 全部通过 |
| `pnpm --filter frontend exec vitest run`（16 个补全相关文件） | 0 | 16 个文件、270 个用例通过 |
| `pnpm --filter @pi-science/server exec vitest run src/runtime/agent/worker/session-runtime.test.ts src/runtime/agent/agent-core-turns.test.ts` | 0 | 2 个文件、20 个用例通过 |
| `pnpm --filter frontend exec playwright test --config playwright.visual.config.ts composer-completion.spec.ts --project desktop-light --project desktop-dark --project mobile` | 0 | 21 个用例通过（7 个用例 × 3 个项目） |
| `pnpm --filter frontend test:accessibility` | 1 | 26 通过、4 失败。失败全部来自主分支既有的 `workspace landing` 对比度检查，见第 5 节 |
| `pnpm test` | 见第 5 节 | 两次整库运行各有一个与本次改动无关的服务端用例超时；单独运行均通过 |

## 3. 验收用例结果

| ID | 结果 | 证据位置 |
|---|---|---|
| AC-01 | 通过 | `ComposerCompletion.test.tsx`；浏览器 `composer-completion.spec.ts` AC-01 |
| AC-02 | 通过 | `agent-core-turns.test.ts`「expands a prompt template invocation into the template message it sends」；`LiveSessionPage.test.tsx` prompt 目录用例 |
| AC-03 | 通过 | `ComposerCompletion.test.tsx`「TC-03 accepts a discovered skill command with Tab」 |
| AC-04 | 通过 | `LiveSessionPage.test.tsx`「/export opens the selected session format without sending a prompt」 |
| AC-05 | 通过 | `ComposerCompletion.test.tsx` 参数候选用例；浏览器 `composer-completion.spec.ts` AC-05 |
| AC-06 | 通过 | `ComposerCompletion.test.tsx`「TC-02 completes a command argument with Tab」 |
| AC-07 | 通过 | `path-provider.test.ts`；浏览器 `composer-completion.spec.ts` AC-07 |
| AC-08 | 通过 | `engine.test.ts`「fills the common prefix when several candidates match」 |
| AC-09 | 通过 | `ComposerCompletion.test.tsx`「shows no menu for an ordinary word that prefixes a root file and still sends on Enter」 |
| AC-10 | 通过 | `ComposerCompletion.test.tsx`「accepts the row under the pointer with Tab」；浏览器 AC-10 |
| AC-11 | 通过 | `ComposerCompletion.test.tsx`「turns an @file candidate into a workspace reference instead of text」 |
| AC-12 | 通过 | `ComposerCompletion.test.tsx` Escape 三条用例 |
| AC-13 | 通过（真实浏览器） | CDP `Input.imeSetComposition` 驱动真实组词事件，见第 4 节 |
| AC-14 | 通过 | `LiveSessionPage.test.tsx`「creates exactly one runtime session for a slash draft and keeps the draft, attachment and reference (AC-14)」 |
| AC-15 | 通过 | `session-actions.test.ts`「shares blank runtime creation between completion and the first prompt」 |
| AC-16 | 通过 | `session-actions.test.ts`「discards a late blank runtime after switching conversations in the same workspace」与「keeps a late blank runtime the user has already opened」 |
| AC-17 | 通过 | `slash-commands.test.ts`「isolates workspaces and sessions when requests finish out of order」 |
| AC-18 | 通过 | `slash-commands.test.ts`「keeps an old session prompt catalogue out of the current session」；`LiveSessionPage.test.tsx` 同名路由用例 |
| AC-19 | 通过 | `session-runtime.test.ts` 命令目录用例；`skills-mutations.test.ts` 与 `SkillsTab.test.tsx` 缓存失效用例 |
| AC-20 | 通过 | `LiveSessionPage.test.tsx` 四条模型状态用例（无模型、模型不可用、切换提示、切换保存中）；UAT 记录「composer clearly disabled sending because no provider/model is configured」 |
| AC-21 | 通过 | `ComposerCompletion.test.tsx`「keeps typing when the file API fails」与「keeps the built-in commands when the command API fails」 |
| AC-22 | 通过 | `ComposerCompletion.test.tsx`「does not swallow keys pressed outside the composer」；浏览器 AC-22 |
| AC-23 | 通过 | 浏览器 `composer-completion.spec.ts` AC-23（375 像素、无横向溢出、长名称截断） |
| AC-24 | 通过 | 浏览器 `composer-completion.spec.ts` AC-24 标记 `@accessibility`，菜单打开时无 serious 或 critical 问题 |

## 4. AC-13 真实输入法验证

命令：

```sh
node .pi/skills/verify-pi-science/scripts/drive.mjs --scenario .pi/verify-pi-science/composer-ime.mjs
```

结果：`PASS`。证据 JSON 为 `.pi/verify-pi-science/evidence/20261009-012426-pr114-ime-7495/drive-2026-10-08T17-35-39-091Z.json`，截图同目录 `composer-ime.png`。

记录的观察值：

| 观察项 | 值 |
|---|---|
| 组词前菜单 | 打开，草稿 `/e` |
| 组词中 | 菜单隐藏，草稿 `/ex` |
| 组词中按 Tab | 草稿仍为 `/ex`，没有补全 |
| 组词中按 Enter | prompt 请求数 0，没有发送 |
| 组词结束方式 | `Input.imeSetComposition` 空串，触发真实 `compositionend` |
| 组词结束后 | 补全恢复，草稿成为 `/export ` |
| 全过程 prompt 请求数 | 0 |

组词事件序列由页面内监听器确认：`compositionstart`、`compositionupdate`、`input`，空串提交后出现 `compositionend`。合成事件单测不能替代该检查，本次使用真实渲染器事件。

## 5. 未通过项与未验证项

### 5.1 本地可访问性检查的对比度差异

`pnpm --filter frontend test:accessibility` 在 `accessibility.spec.ts:35`（workspace landing）失败，仅 4 个浅色桌面项目，报侧栏 4 个节点的对比度（`#84888c` on `#fafbfc` 为 3.44:1，`#999c9f` on `#fbfcfc` 为 2.68:1）。

判定为环境差异，不属于本次改动：

- 失败节点全部在侧栏。`ConversationNavRail.tsx`、`ProjectsLayout.tsx`、`index.css`、`tailwind.config.js` 在本 PR 与合并结果之间与主分支逐字节一致（`git diff --stat 0b726af6 HEAD --` 这些路径只显示主分支自己的 1 行注释改动）。
- 主分支自己的 nightly `visual` 运行（`410e8daf`，2026-10-08）里，同一批 `accessibility.spec.ts` 用例在 Linux 上全部通过。
- 本机为 macOS 与 Chrome 151；CI 为 ubuntu-latest。

新增的补全菜单可访问性用例（AC-24）在 6 个项目上全部通过，其中本机运行的 3 个项目全部通过。

### 5.2 整库测试的偶发超时

`pnpm test` 三次运行里，`src/runtime/notebooks/notebook-service.test.ts`（`binds jupyter to the workspace root and fences cross-workspace control`）都失败，报 `vi.waitFor` 在默认 1 秒内没等到 shim 写出 argv 文件。

分类为既有问题，不是本次改动引入：

- 把两个新增的服务端测试文件回退到合并提交 `b3bfeb5e`（即不带本次新增用例）后再跑整库服务端测试，同一用例仍然失败（1018 毫秒超时）。
- 该文件单独运行两次都通过（9 通过）。
- 失败模式是 `vi.waitFor` 的 1000 毫秒默认预算对「spawn 一个 Node shim 并写文件」太紧，在整库并行运行下不够。
- `apps/server/src/runtime/notebooks/` 与本次改动无关，本 PR 只改前端。

另一次整库运行失败在 `src/http/routes/business-routes.test.ts`（5 秒用例超时，单独运行 47 通过、7 跳过），同样与本改动无关。

附带问题：失败运行会留下常驻的 `jupyter-lab` shim 进程，会继续加重负载，本次已手动清理。

### 5.3 真实发送路径未验证

本机配置的模型（`user-custom-api/gpt-5.5`）在隔离实例的 canary 回合里两次 120 秒无响应，因此：

- 隔离实例改用 `--no-model-config` 启动，仅用于 AC-13 与 AC-20 的真实浏览器验证。
- `pnpm uat:conversation` 输出：workspace marker 与「无模型时发送被禁用」通过，会话创建与真实 prompt 分支 SKIP。SKIP 不作为真实发送通过的证据。
- 服务端展开路径由 `agent-core-turns.test.ts` 与 `session-runtime.test.ts` 覆盖，前端「接受候选不发送」由浏览器用例计数 prompt 请求为 0 覆盖。

### 5.4 主分支既有问题（不属于本 PR）

- 视觉截图套件在 `410e8daf` 的 nightly 运行里已经失败：`app-shell.visual.spec.ts`、`conversation.visual.spec.ts`、`inspector.visual.spec.ts`。原因是 fixture 的 history 只有孤立的 `toolResult`，没有配对的 `toolCall`，Core 对齐后不再渲染 bash 工具卡，`waitForConversationSettled` 因此超时。渲染相关文件在本 PR 与主分支之间逐字节一致。
- 上述失败运行留下的 `jupyter-lab` shim 进程不会自动回收。

## 6. 评审发现与修复

独立评审（两个只读评审 agent）提出 3 个 P1 与 2 个 P2，全部已修复，每条都有先失败后通过的测试：

| 编号 | 问题 | 修复 | 先失败证据 |
|---|---|---|---|
| P1-1 | 过期创建结果的清理会删除用户已经打开的会话 | `session-actions.ts` 增加「会话已被使用」判断后再删除 | `keeps a late blank runtime the user has already opened`：修复前 DELETE 被调用 |
| P1-2 | 切换工作区时，预创建 effect 用旧工作区的草稿初始化新工作区 | `LiveSessionPage.tsx` 记录上一次工作区，跳过工作区变化的那一次提交 | `does not initialize a workspace the slash draft was not typed in`：修复前 create 被调用 1 次 |
| P1-3 | 首次发送的晚到回调写入用户已切走的会话 | `sendPrompt` 的失败分支增加会话判断；`useComposer` 的 then/catch 按发送时会话判断，导航使用实时路径 | `does not fail a conversation the user switched to while a lazy creation failed`（修复前 `turnLifecycle` 为 failed）；`does not refill the composer after the user moves to another conversation`（修复前草稿被写回）；`does not pull the user back to a session created for a send they left`（修复前导航被调用） |
| P2-1 | 模型就绪 guard 只在工作区里，未提交 | 随 `374c07ad` 提交 | — |
| P2-2 | 新增路由测试的类型错误让 `tsc -b` 失败，`pnpm build` 退出码 1 | 修正 mock 返回类型 | `pnpm --filter frontend exec tsc -b` 修复前报 5 处 TS2322 |

`pnpm --filter frontend typecheck` 只检查 `tsconfig.app.json`，不覆盖测试文件，所以没有发现 P2-2；`pnpm build` 的 `tsc -b` 才会检查。后续验证以 `pnpm build` 为准。

## 7. 结论

- PRD 第 6 节的逐文件方案已全部落实，第 7 节 AC-01 至 AC-24 均有测试结果或浏览器证据。
- 冲突解决、旧菜单与旧全局命令 API 的清理、纯逻辑层无 React 与 HTTP 依赖均已核对。
- 待合并提交上的 `pnpm build`、`pnpm smoke`、前端 lint、聚焦测试与浏览器用例全部通过。
- 未闭环项集中在第 5 节：本机可访问性对比度差异、整库测试的偶发超时、真实发送路径缺少可用模型、以及主分支既有的视觉截图失败。
