---
name: scheduled-tasks
description: 管理 Pi-Science 定时任务：创建、查看、修改、删除、手动运行与审批。当用户要求创建/查看/修改/删除定时任务、定时文献收集、定期跑分析或报告时使用（例如「每天早上 9 点自动收集肺癌最新文献」「每周一汇总 arXiv 论文」「帮我建一个每晚运行的文献综述任务」）。Manages scheduled tasks in the current Pi-Science workspace via the control-plane HTTP API. Use when the user asks to create, list, update, delete, manually run or approve a scheduled task (recurring literature digests executed by a headless agent), e.g. "set up a weekly literature digest". Do not use for one-off questions or single searches.
version: 0.1.0
license: Apache-2.0
category: productivity
requirements:
  - name: control-plane
    kind: service
    description: 本机控制面 HTTP API（http://127.0.0.1:<port>，端口取环境变量 PI_SCIENCE_PORT，默认 8787）。所有定时任务操作都通过该 API 完成。
  - name: curl
    kind: command
    description: 用 curl 调用控制面 API。
risk: low
---

# 定时任务（scheduled-tasks）

本技能通过**控制面 HTTP API** 管理当前 workspace 的定时任务。定时任务 = 按 cron 周期运行的文献综述（`literature_digest`），由无头 agent 执行，报告写回 workspace。

## 何时用、何时不用

- **用**：用户要求创建、查看、修改、删除定时任务；定时文献收集；定期跑分析或报告；手动触发一次任务；审批待批准任务。
- **不用**：用户只是问问题、做一次性检索。直接正常回答或检索，不要创建任务。

## 唯一正确入口

- 所有操作只能通过控制面 HTTP API，地址 `http://127.0.0.1:<port>/api/scheduled-tasks*`。
- 端口来自 bash 环境变量 `PI_SCIENCE_PORT`，默认 8787；实际端口以服务为准，不确定时先探测：`curl -s http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/health`。
- **严禁**直接编辑、创建或删除 workspace 下 `.pi-science/scheduled-tasks/` 目录里的 JSON 文件（tasks/runs/logs）。直接改文件会绕过 schema 校验、敏感词预检、审批和文件锁，绝不允许。
- **cwd 参数**：每个 API 都要带 query 参数 `cwd` = workspace 根目录。agent 的 bash 工具 cwd 就是 workspace 根，执行 `pwd` 即可得到，示例统一用 `?cwd=$(pwd)`。
- **边界**：只能操作当前 workspace，绝不传其他 workspace 路径，绝不跨 workspace 操作。

## API 总览

### 列出任务

    curl -s "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks?cwd=$(pwd)"

→ `200 {"tasks": [<task>, ...]}`；没有任务时 `tasks` 为空数组。

### 查看单个任务

    curl -s "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>?cwd=$(pwd)"

→ `200` task 对象；任务不存在 → `404 {"error": "Scheduled task not found"}`。

### 创建任务（body 见下方完整示例）

    curl -s -X POST "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks?cwd=$(pwd)" \
      -H 'Content-Type: application/json' -d '{...}'

→ `201` 完整 task 对象（含 `approval`，创建后必须检查）；校验失败 → `400 {"error": "..."}`。

### 修改任务（只传要改的字段）

    curl -s -X PATCH "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>?cwd=$(pwd)" \
      -H 'Content-Type: application/json' \
      -d '{"name": "新名字", "schedule": {"cron": "0 10 * * 1-5", "timezone": "Asia/Shanghai"}}'

可改字段：`name`、`enabled`、`schedule{cron,timezone}`、`executor{config}`、`output{relative_path}`、`retry{max_attempts}`。→ `200` 更新后的 task；不存在 → `404`。

### 删除任务

    curl -s -X DELETE "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>?cwd=$(pwd)"

→ `200 {"ok": true}`；不存在 → `404`。

### 手动运行（立即触发一次）

    curl -s -X POST "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>/run?cwd=$(pwd)"

→ `200` run 对象。注意：审批未通过（`pending`）时不会执行，run 的 `status` 为 `needs_attention`。

### 审批（敏感词命中后，用户同意才调用）

    curl -s -X POST "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>/approve?cwd=$(pwd)" \
      -H 'Content-Type: application/json' \
      -d '{"categories": ["<task.approval.categories 原样回传>"]}'

→ `200` task（`approval.status` 变为 `approved`）；categories 不一致 → `400`，错误含 `approval categories mismatch`。

### 运行历史与日志

    curl -s "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>/runs?cwd=$(pwd)"
    curl -s "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks/<task_id>/runs/<run_id>?cwd=$(pwd)"

前者 → `200 {"runs": [...]}`（最多 100 条）；后者 → `200` run 对象 + `log_tail`（运行日志末尾 8000 字符）。run 的 `status` 取值：`pending / running / succeeded / failed / needs_attention / skipped`。

## 创建 literature_digest 任务：完整示例

    CWD=$(pwd)
    curl -s -X POST "http://127.0.0.1:${PI_SCIENCE_PORT:-8787}/api/scheduled-tasks?cwd=$CWD" \
      -H 'Content-Type: application/json' \
      -d '{
        "name": "肺癌最新文献日报",
        "type": "literature_digest",
        "enabled": true,
        "schedule": {"cron": "0 9 * * 1-5", "timezone": "Asia/Shanghai"},
        "executor": {
          "kind": "headless_agent",
          "config": {
            "query": "lung cancer immunotherapy",
            "providers": ["pubmed", "arxiv", "crossref"],
            "instructions": "重点关注临床试验与综述，来源不少于 8 篇"
          }
        },
        "output": {"relative_path": "reports/literature/lung-cancer-daily"}
      }'

请求体字段：

- `name`：必填，任务名。
- `type`：目前只有 `literature_digest`（可省略，默认就是这个）。
- `enabled`：默认 `true`。
- `schedule.cron`：5 段标准 cron（分 时 日 月 周）。`"0 9 * * 1-5"` = 工作日 9:00。格式错 → 400。
- `schedule.timezone`：IANA 时区名，如 `Asia/Shanghai`、`UTC`。非法 → 400。
- `executor.kind`：`"headless_agent"`（默认）。
- `executor.config.query`：**必填非空**，检索词。缺了创建时不一定报错，但运行必失败。
- `executor.config.providers`：可选，来源库子集：`pubmed` / `arxiv` / `crossref` / `genbank` / `pubchem` / `uniprot`。
- `executor.config.instructions`：可选，附加给执行 agent 的要求。
- `output.relative_path`：必填，workspace 内相对目录。报告写到该目录下 `<日期>.md`（如 `2026-08-17.md`）和 `<日期>.manifest.json`（来源清单）；当日文件若被外部改过，会改写带时间戳的副本。
- `retry.max_attempts`：可选，默认 2（1–10）。

## 审批流程（重要）

创建或修改后，先检查响应里 `approval.status`：

- `none`：执行内容未命中敏感词，已可直接调度。
- `pending`：执行内容命中敏感词检测（DNA/蛋白序列、化合物标识、临床标识、自定义词等）。**必须**把响应里 `approval.categories`（及 `terms`）展示给用户确认；用户明确同意后，再调用 approve，`categories` 用响应里返回的数组**原样**回传。
- `approved`：已批准。

只有 `enabled` 且 `approval.status != "pending"` 的任务才会被调度（`next_run_at` 才会计算）。审批通过前手动 run 不执行（`needs_attention`）。**编辑执行内容（cron、executor.config、output 路径）会使审批作废**：content_hash 变化后重新检测，通常回到 `pending`，需要再次展示并重新 approve。

## 手动运行与验证

- 创建且审批通过后，先 `POST .../run` 手动触发一次验证，确认配置正确、报告能生成。
- 运行结果：run 对象里的 `output_paths` 是 workspace 相对路径；报告内容在 `output.relative_path` 目录下。
- 完整日志看 `GET .../runs/<run_id>` 的 `log_tail`。
- 把报告位置告诉用户，例如 `reports/literature/lung-cancer-daily/2026-08-17.md`。

## 常见失败与修法

- `400 invalid cron expression: expected 5 fields`：cron 不是 5 段。改成标准 5 段后重发。
- `400 invalid timezone: ...`：时区名非法。换成合法 IANA 名。
- `403 Path is not a registered workspace: ...`：`cwd` 不是受管 workspace（缺少 `.pi-science/` 标记且不在 `PI_SCIENCE_WORKSPACES` 根下）。只传当前 workspace 的 `pwd`。
- `404 Scheduled task not found`：`task_id` 拼错或不在当前 workspace。先 GET 列表拿准确 id。
- `400 approval categories mismatch: expected [...]`：approve 的 categories 与任务响应不一致。原样复制响应数组。
- 运行失败 `[non-retryable] Artifact path escapes the workspace`：`output.relative_path` 越界（绝对路径、`..` 逃逸、含 `.pi-science` 元数据路径）。改成 workspace 内相对路径。
- 运行失败 `requires a non-empty executor.config.query`：创建时漏了 `query`。PATCH 补上。
- 其他运行失败：错误信息原样转述给用户，`[non-retryable]` 前缀表示不会自动重试。
