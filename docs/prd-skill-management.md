# PRD：设置页 Skills 新增能力（对齐 Claude Science）

> 状态：草稿 PRD（待评审）
> 范围：`frontend/src/components/settings/SkillsTab.tsx` + `/api/settings/skills` + `/api/skills` 相关服务
> 目标版本：基于当前 `main`（0dcf5c3）的下一个功能分支

## 1. 背景与现状

pi-science 设置页的 **Skills** 标签页目前只能：

- 列出内置 / 用户 / 项目已发现的技能（`unifiedSkillCatalog`）；
- 对每个技能启用或停用（`PUT /api/settings/skills/toggle`）；
- 重置技能策略（`DELETE /api/settings/skills`）。

它没有“新增技能”的入口。用户只能在文件系统里手工创建 `.pi/skills/<name>/SKILL.md`，再依赖运行时扫描发现。

而 Claude Science（`~/pi/reverse_cs/analysis`）的 Skills 管理页提供了一组明确的 **Add skill** 新增方式，并且技能有来源/级别分组（Anthropic / Imported / Organization / Personal）。

## 2. 调研结论：Claude Science 的几种新增方式

来自 `~/pi/reverse_cs/analysis/extracted/assets/web-dist/assets/CapabilitiesPage-Bj_qOj7X.js` 的 Add skill 菜单：

| # | 方式 | UI 文案 | 行为 |
|---|------|---------|------|
| 1 | **会话中创建** | Chat with Claude | 打开新会话，让用户描述技能，由 agent 用 skill-creator 流程生成 |
| 2 | **从零编写** | Write from scratch | 打开 skill creator / 编辑器，填写 name + description + 正文 |
| 3 | **上传技能** | Upload a skill | 拖放 `.md`、`.zip` 或 `.skill`，解析 SKILL.md / 解包 bundle |
| 4 | **从 GitHub 导入** | Import from GitHub | 输入 `owner/repo` 或 GitHub URL，预览并批量导入仓库中 `skills/` 或 plugin-marketplace 布局的技能 |

Claude Science 还提供编辑、复制（duplicate）、发布到 registry、删除等生命周期操作；其中 `skill_publish` 后技能可通过 `skill(...)` 被 agent 加载，attach 到 profile 后供特定 agent 使用。导入/发布的技能默认有来源属性；草稿通过 `host.skills.publish` 提升为 live skill。

## 3. 目标

让 pi-science 设置页 Skills 标签页具备“新增技能”能力，对齐 Claude Science 的四种新增方式，并符合 pi-science 本地优先、项目工作区隔离的架构。

**默认新增级别为项目级别（project）**：新技能写入当前工作区的 `.pi/skills/<name>/`，仅对当前项目可见，不污染用户级或内置技能目录。

## 4. 非目标（本期不做）

- 不实现技能市场 / 远程 registry / 发布到云（后续单独 PRD）。
- 不做“组织级/全局级/用户级切换”的完整范围管理；本期只提供项目级默认，用户级可保留现有 `~/.pi/agent/skills` 手工方式，不新增 UI 写入用户级。
- 不做技能 eval/benchmark 全流程（可复用 `docs/skill-authoring.md` 的校验契约，但不做 skill-creator 的 evals）。
- 不做 Claude Science 的 `kernel.py` 侧车机制；沿用 pi-science 现有 SKILL.md + helper 脚本结构。
- 不改变现有技能启用/停用策略逻辑。

## 5. 用户故事

1. 作为科研用户，我想在设置页直接“新增技能”，而不必手动创建目录，以便把重复工作流固化成技能。
2. 作为项目成员，我新增的技能默认只属于当前项目，避免影响其他项目。
3. 作为有现成技能文件的用户，我想直接上传 `SKILL.md` 或 `.zip`，系统校验后放入当前项目。
4. 作为看到好技能仓库的用户，我想从 GitHub 导入技能，系统自动挑选 `skills/` 目录中的技能。
5. 作为只想描述想法的用户，我想通过“让助手帮我写”入口进入会话，让 agent 按 skill-authoring 契约生成项目级技能。

## 6. 功能需求

### 6.1 UI：Add skill 入口

- 在 `SkillsTab` 头部右侧增加一个 **Add skill** 下拉按钮，与现有 reset 按钮并列。
- 菜单项（对齐 Claude Science）：
  1. **从零编写**（Write from scratch）：打开内置的表单编辑器。
  2. **上传技能**（Upload a skill）：打开上传区，支持 `.md`、`.zip`（以及后续 `.skill` 可选）。
  3. **从 GitHub 导入**（Import from GitHub）：打开 GitHub 仓库输入框，支持 `owner/repo`、`owner/repo@ref`、完整 GitHub URL。
  4. **让助手帮我写**（Chat with Claude / 会话中创建）：在当前会话中插入一条指令，引导 agent 调用 skill-authoring 能力创建项目级技能（也可直接跳转到新会话）。
- 列表项视觉上增加来源/级别标记：`builtin` / `project` / `user`，便于用户识别新技能已落到项目级。
- 新增技能成功后刷新列表并给成功提示；失败展示校验错误。

### 6.2 从零编写

- 轻量表单字段：
  - `name`：小写连字符，默认由 displayName slug 生成，必须与目录名一致；
  - `description`：一句话触发条件（必填，≤200 字符提示）；
  - `body`：Markdown 正文；
  - 可选元数据：`version`、`license`（默认 `Apache-2.0`）、`category`、`requirements`。
- 保存时调用 `POST /api/skills`（或 `/api/settings/skills`，最终以实现定）创建项目级技能目录 `.pi/skills/<name>/SKILL.md`。
- 创建前校验名称唯一性：若 `.pi/skills/` 下已存在同名，或与内置/用户技能同名冲突，提示用户改名。

### 6.3 上传技能

- 支持：
  - 单个 `SKILL.md` 文本文件：解析 frontmatter 后直接创建项目技能；
  - `.zip` bundle：解压到临时目录后校验，选择包含 `SKILL.md` 的目录作为技能根目录；若 zip 内含多个技能，逐个列出让用户选择或全部导入。
- 校验沿用 `POST /api/skills/validate` 的规则（frontmatter 合法、name 与目录一致、license、文件大小限制）。
- 安全要求：
  - zip 解压必须防 zip-slip（拒绝 `../`、绝对路径、符号链接）；
  - 单文件大小和总大小设上限（建议沿用 `MAX_SKILL_BYTES` / `MAX_REFERENCE_BYTES`，zip 上限可独立配置如 20MB）；
  - 解压仅在临时目录，最终只复制白名单内普通文件到 `.pi/skills/<name>/`。

### 6.4 从 GitHub 导入

- 输入解析：`owner/repo`、`owner/repo@ref`、`https://github.com/owner/repo` 或 `.../tree/ref/...`。
- 流程：
  1. 服务端调用 GitHub API 或 clone（浅克隆）获取仓库 `skills/` 目录清单；
  2. 列出候选技能（SKILL.md 所在目录），用户选择要导入的技能；
  3. 服务端复制选定技能到当前项目 `.pi/skills/<name>/`；
  4. 每个技能导入前执行校验，不通过则标记失败原因。
- 安全要求：
  - 只允许 `github.com` 域名，URL 必须通过现有 `validateOutboundHttpUrl`；
  - 出网请求进入 egress 审计；
  - 导入内容限制在项目 `.pi/skills/` 内，禁止路径逃逸；
  - 不自动执行任何导入脚本，只作为文件落地。

### 6.5 会话中创建

- 点击后不写文件，而是在当前会话输入框注入一条消息，例如：
  “请帮我创建一个项目级技能：<用户后续补充需求>。请遵循 `docs/skill-authoring.md` 的契约，把技能写到当前项目的 `.pi/skills/<name>/SKILL.md`。”
- 设置页关闭后由 agent 完成交互式澄清与创建；创建后技能列表通过刷新可见。

### 6.6 项目级默认与生命周期

- 所有新增技能默认 `source: "project"`，落盘到 `cwd/.pi/skills/<name>/`。
- 项目技能可被现有 `discover()` 扫描到（已支持），并受 `SOURCE_RANK` project 优先覆盖同名内置/用户技能。
- 本期新增操作包括：创建、上传、导入；**编辑与删除**作为配套提供最小编码：
  - “删除项目技能”：仅允许删除 `source === "project"` 的技能，调用 `DELETE /api/settings/skills/:skill_id`，删除 `.pi/skills/<name>/` 并刷新运行时。
  - “编辑项目技能”：可复用现有 `GET /api/skills/:skill_id/content` 读回内容，保存时重写项目 SKILL.md。
- 内置/用户技能不出现在编辑/删除操作中，避免破坏受管资源。

## 7. 后端改动建议

### 7.1 新增/扩展 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/settings/skills?cwd=` | 创建项目技能（JSON：name/description/body/metadata） |
| `POST` | `/api/settings/skills/upload/preview?cwd=` | 上传预览 `.md` / `.zip`，返回候选技能列表 |
| `POST` | `/api/settings/skills/upload/import?cwd=` | 按选定 root 导入上传的技能 |
| `POST` | `/api/settings/skills/import-github/preview` | 输入 repo 预览 GitHub 仓库内候选技能 |
| `POST` | `/api/settings/skills/import-github/import?cwd=` | 按选定 root 导入 GitHub 技能 |
| `PUT` | `/api/settings/skills/:skill_id?cwd=` | 编辑项目技能内容 |
| `DELETE` | `/api/settings/skills/:skill_id?cwd=` | 删除项目技能 |

所有写操作必须：
- 通过 `validateWorkspaceCwd` 拿到当前项目根；
- 目标路径限制在 `<root>/.pi/skills/` 且使用 `pathIsInside` 校验；
- 写入前调用 `validateSkillDir` 风格校验；
- 成功后调用 `nodeSessionService.refreshAllRuntimeSkills()`，与现有 toggle/refresh 行为一致。

### 7.2 存储与发现

- 无需新增配置文件字段；项目技能就是 `.pi/skills/` 下的目录，天然被 `discoverRaw` 发现。
- `seedWorkspaceAssets` 当前只镜像内置技能目录，不会清理非同名项目技能目录，因此 `.pi/skills/<custom>/` 是安全落点（需在实现时补充测试固化该行为）。

### 7.3 契约调整

- `SkillInfo` / `SkillContent` 已包含 `source`，足够前端显示级别。
- 可能需要为 `SkillInfo` 增加 `editable`/`deletable` 派生字段（`source === "project"`），或由前端判断。

## 8. 前端改动建议

- 扩展 `SkillsTab.tsx`：Add skill 菜单、创建/上传/导入弹层、来源徽标。
- 新增 `frontend/src/lib/skills/skills-mutations.ts` 或扩展现有 `skills-api.ts`，封装新 API + query invalidation。
- i18n：`en.json` / `zh-Hans.json` 增加 `skills.add`、`skills.create`、`skills.upload`、`skills.importGithub`、`skills.source.project` 等文案。
- 视觉遵循 `docs/ui/deepseek-harness-reference.md`，不引入新设计 token。

## 9. 安全与风险

| 风险 | 缓解 |
|------|------|
| zip 解压路径逃逸 | 临时目录解压 + 白名单复制 + 仅普通文件，拒绝 symlink/device |
| GitHub 导入 SSRF / 外发 | 仅 `github.com`、`validateOutboundHttpUrl`、egress 审计 |
| 覆盖内置/用户技能 | 写入仅限项目 `.pi/skills/`；同名冲突要求改名，不自动覆盖 |
| `.pi/skills` 是托管区误删 | 只增不改内置 seed 目录；对非内置目录不做 seed 清理；补充 seed 测试 |
| 大文件 / zip bomb | 文件大小、总大小、解压层数与条目数限制 |
| 恶意技能内容 | 沿用现有 frontmatter 校验 + license/risk 约束；不自动执行脚本 |

## 10. 验收标准

1. 设置页 Skills 出现 Add skill 菜单，包含：从零编写、上传、从 GitHub 导入、让助手帮我写。
2. 从零编写保存后，`<project>/.pi/skills/<name>/SKILL.md` 存在，列表出现 `project` 徽标，agent 可发现该技能。
3. 上传单个 `SKILL.md` 和 `.zip` 均能创建项目技能；非法 frontmatter 显示明确错误。
4. 从 GitHub 导入：输入 `owner/repo` 后能预览候选技能；导入后技能可被项目列表发现。
5. 新建技能默认 `source: "project"`，不写入 `~/.agents/skills` 或仓库 `skills/`。
6. 项目技能可编辑、可删除；内置/用户技能不可删除。
7. 所有写操作失败不破坏现有技能、不遗留 `.pi/skills` 外文件。
8. `pnpm typecheck`、`pnpm test`、`pnpm test:skills` 通过；新增组件/API 有 vitest 覆盖。

## 11. 里程碑建议

- **M1**：后端“创建项目技能 + 上传”API + 安全校验 + 测试。
- **M2**：前端 Add skill 菜单 + 从零编写 + 上传 UI + i18n。
- **M3**：GitHub 导入 API/UI（出网安全 + 审计）。
- **M4**：编辑/删除项目技能 + 端到端验证。
- M1/M2 可先行交付，M3/M4 视评审结果追加。