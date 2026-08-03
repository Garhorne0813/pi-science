# Pi-Science 技能作者指南

内置技能位于仓库 `skills/<name>/`，随每个工作区自动 seed 到 `.pi/skills/`（整个技能目录，含脚本、引用与资产）。本指南定义作者契约；CI 通过 `pnpm test:skills`（`skills/skill-contract.test.ts` + 各技能 `tests/`）强制校验。

## 目录结构

```
skills/<name>/
├── SKILL.md            # 必填：frontmatter + 正文（触发条件、工作流、检查点）
├── tests/              # 推荐：vitest（skill-content.test.ts）+ fixtures.json
├── reference/          # 可选：大引用文件（每个 ≤ 512KB，更大请拆分）
├── *.py / *.js / *.sh  # 可选：helper 脚本（frontmatter requirements 声明依赖）
└── requirements.txt / pyproject.toml   # 可选：依赖清单
```

## Frontmatter 必填字段

```yaml
---
name: my-skill            # 小写连字符，必须与目录名一致（强制）
description: "一句话触发条件 + 作用。首行 ≤ ~200 字符，全文 ≤ 1024 字符"
version: 0.1.0
license: Apache-2.0       # 必须显式声明（内置技能缺失 = 校验失败）
---
```

- **license 必填**：缺失时默认回退为 `UNLICENSED`（不再静默假定 Apache-2.0）并产生校验警告；内置技能缺失直接校验失败。第三方依赖逐项在 `third_party` 声明其 license。
- **description 渐进披露**：description 是模型发现技能时唯一可见的摘要，第一句应是精准触发条件；细节放正文按需披露，避免全文塞进 description 造成每次会话的 token 膨胀。

## 可选字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `category` | string | 默认 `general`，如 `research`/`visualization`/`chemistry` |
| `risk` | `low`/`medium`/`high` | 高风险的技能应声明 `required_tools` 或 `required_mcp_tools` |
| `requirements` | array | 每项 `{ name, kind: command/python/node/r/package/gpu/service, version?, optional?, description? }`；只读类技能用 `optional: true` 保持零配置可用 |
| `third_party` | array | 每项 `{ kind, name, provider?, license?, terms_url?, info_url?, privacy_url? }`，**license 必填** |
| `entrypoints` | array | 入口文件相对路径；必须真实存在于技能目录（强制） |
| `required_tools` / `required_mcp_tools` | array | 运行时必需的工具/MCP 工具名 |
| `compatibility` | string | 互操作提示（如 `claude`、`pi`、`*`），仅作信息元数据 |
| `metadata` | object | 扩展元数据（透传保留） |

## 不支持的 Claude Code 专属字段

以下 Agent Skills 字段会被解析但**不生效**，并在校验中产生警告：`allowed-tools`、`disable-model-invocation`、`model`。不要依赖它们约束 pi-science 运行时的行为。

## 校验规则（`pnpm test:skills` 强制）

- frontmatter 必须是合法 YAML 且通过 `skillMetadataSchema`
- 内置技能必须显式声明 license；目录名 === 技能名
- `entrypoints` 声明的文件必须存在
- 大文件（> 512KB）与过长 description（> 1024 字符）产生警告
- 每个技能自己的 `tests/*.test.ts` 会被同一命令发现并执行（无需登记）

## 运行时行为

- 技能目录由 `seedWorkspaceAssets` 完整镜像到工作区 `.pi/skills/<name>/`；源树中的符号链接不会被复制；目标侧残留的符号链接或类型不匹配条目（树根或任意嵌套层级）会被先移除再重建，绝不穿透链接写入或删除外部位置；失效/过期文件会被清理
- **警告：内置技能目录（`.pi/skills/<builtin>/`）是完全托管区**。seed 会清理其中所有无上游对应的文件（每次清理都会输出 `removing stale seeded entry` 日志）；请勿在其中放置自定义文件，自定义技能请放在独立目录（不随 seed 管理的位置）
- 技能通过 Pi 的 `--skill` 注入；MCP 工具优先时在正文写明探测/回退策略（参考 `literature-review`）
