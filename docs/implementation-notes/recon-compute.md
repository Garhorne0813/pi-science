# 计算 / 远程执行勘察报告（方案 4.5 实现准备）

勘察基线：branch `feat/reverse-cs-inspiration`（clean，HEAD 0af0c5b），CLAUDE.md 三进程边界与
docs/reverse-cs-inspiration.md §4.5。以下均为只读勘察，未修改任何文件。

## 0. 一句话结论

Pi-Science 已有一个完整、健壮的本地 JobCoordinator（submit/list/get/cancel/logs + 断线孤儿接管 + 进程组终止 + 所有权心跳租约），
以及基于系统 `ssh`/`sshpass` 的机器 CRUD 与只读探测，但 `POST /api/compute/run` 是硬编码 stub（返回
`{ok:false,"Remote dispatch requires a configured executor"}`）。方案 4.5 的全部远程环节（staging/submit/harvest/reconcile/远程provenance）
均可从零实现，但可大量复用：本地 JobRecord 状态机模型、job-routes 的 API 形状、artifact 注册双通道、SSE 流式通道、
以及 catalog-routes 里已有的 SSH 参数拼装与鉴权逻辑。

---

## 1. 现有计算能力清单

### 1.1 本地执行（成熟，控制面内）
- `apps/server/src/runtime/jobs/job-coordinator.ts`（358 行）是一个完整的本地作业状态机：
  - 状态机：`JobStatus = pending | running | succeeded | failed | cancelled | timed_out`，`isTerminal/isNonterminal` 两个守卫。
  - `JobRecord`：`{job_id, command[], cwd, execution_cwd?, surface, status, created_at, started_at?, ended_at?, return_code?, stdout, stderr, artifact_ids[], environment, requirement, ownership?}`。
  - 提交 `submit(cwd, body)`：解析 command→能力校验(capabilities)→构建受限 research 环境→写 pending 记录→`run()`。
  - 能力探测 `capabilities(requirement)`：cpu/gpu/runtime(有 python、node、r:null)/packages。
  - 执行 `run()`：`spawn`（detached=POSIX，进程组）→ 追加尾部 stdout/stderr（截断 100KB）→ 超时(timeout_seconds)→ `terminate()`（SIGTERM→KILL，进程组）→ 终态写盘。
  - 持久化：`metadataRoot(cwd)/jobs/<job_id>.json`（`.pi-science/jobs/`），锁为 `withFileWriteLock` 文件锁。
  - 断线/孤儿恢复 `healOrphan` + 所有权机制：`JobOwnership{instance_id,pid,token,generation,heartbeat_at,lease_expires_at,child}`，心跳刷新租约（30s lease / 5s heartbeat / 15s 宽限），孤儿进程用 `/proc/<pid>/stat` 进程身份（linux-proc-start-ticks / ps-lstart）做 fencing 后 reap。这是跨进程安全的核心。
  - cancel / shutdown：cancel 打标签→terminate 进程组→写 cancelled；shutdown 遍历 `children` 终止。
- API（`apps/server/src/http/routes/job-routes.ts`）：`POST /api/jobs/capabilities`、`POST /api/jobs`（submit）、`GET /api/jobs?limit`、`GET /api/jobs/:id`、`DELETE /api/jobs/:id`（cancel）、`GET /api/jobs/:id/logs`。`onClose → jobs.shutdown()`。
- `runtime-boundaries.ts` 声明 `/api/jobs` 与 `/api/compute` 均为 node-control-plane native。
- JobCoordinator 无远程能力、无机器绑定：它只 spawn 本机进程，不知 SSH、不知远端。

### 1.2 SSH / 远程配置（只到"连接与探测"，不透支执行）
- 唯一 SSH 代码在 `apps/server/src/http/routes/catalog-routes.ts`（"Compute machine registry"，约 401-406 行）：
  - `GET/POST/DELETE /api/compute/machines`：CRUD 到 `.pi-science/compute.json`（workspace-local），字段 `{label,host,user,port,identity_file,scheduler,auth_method}`。密码不入库（`const {password:_,...safe} = machine` 剥离）。
  - `POST /api/compute/probe`：`probeComputeMachine()` 用系统 `ssh`（key，`BatchMode`/`StrictHostKeyChecking=accept-new`）或 `sshpass -e ssh`（password）执行 `REMOTE_PROBE_COMMAND`（hostname/os/cores/memory/gpus/has_slurm）。
  - `POST /api/compute/run`：stub，返回 `{ok:false,"Remote dispatch requires a configured executor"}` —— 方案 4.5 在此接入。
  - 探测实现已含：host 正则校验、端口校验、ConnectTimeout=8s、ServerAlive 保活、sshpass ENOENT 友好报错、stdout/stderr 上限、12s 超时 kill。
- 无 npm SSH 库（server package.json 仅 fastify/yaml/zod）。SSH 走系统二进制，与前端一致。
- 无 staging、无 remote job 持久化、无 cancel 到远端、无 output 回收、无远程 provenance。

### 1.3 Job 管理是否存在
- 存在但仅限本地。尚无 remote job 概念、无远端 job ID 持久化、无远端状态轮询/reconcile。`hasActive(cwd)` 用于防 rename/delete 冲突。

### 1.4 计算设置 UI（`frontend/src/components/settings/ComputeSettings.tsx`，336 行）
- 连接表单：label/host/user/port/scheduler(direct SSH 或 Slurm)/auth_method(key 或 password)/identity_file。密码仅用于 probe，不落盘且 UI 明示 not saved。
- 机器列表：probe（test connection）、delete；结果用 `ProbeDetails` 展示 hostname/os/cores/memory/gpus/slurm。
- 数据流：`queryClient ["compute","machines",cwd]` → `/api/compute/machines?cwd=`；probe → `/api/compute/probe`。
- 由 `SettingsContent.tsx` 以 `<ComputeSettings workspaceCwd={scope}/>` 渲染，per-workspace 作用域（scope 传入）。i18n key：`settings.computePage.*`。
- 无任何 job 列表/提交/日志/cancel UI —— 这是 4.5 的前端空白点。

---

## 2. 计算设置的数据模型与 API

数据模型（`.pi-science/compute.json`，workspace-local canonical）：
`{ machines: Machine[] }`，`Machine = {label, host, user, port, identity_file, scheduler, auth_method}`。无密码、无每次执行凭据、无远端作业映射。

API（`/api/compute/*`，node 原生，已注册于 runtime-boundaries）：

| 方法/路径 | 说明 |
|---|---|
| GET /api/compute/machines | 读 `.compute.json` 的 machines |
| POST /api/compute/machines | 加/覆盖 machine，剥离 password |
| DELETE /api/compute/machines/:label | 删除 |
| POST /api/compute/probe | 单次探测（ssh/sshpass） |
| POST /api/compute/run | stub（4.5 接入点） |

契约（`packages/contracts/src/index.ts`）：
- `jobRecordSchema`：`{id,status:"queued|pending|running|succeeded|failed|cancelled|timed_out",created_at,updated_at?,error?}`（泛化，无 command/cwd/artifact_ids，与 server 的 `JobRecord` 不同源）。
- `artifactManifestV2Schema`：`{schema_version:2, artifact_id, version, path, kind, mime, size, sha256, published_at, inputs[], supersedes, classification}`。无 remote/provider/job 字段。
- 无 ComputeMachine/RemoteJob 专用 schema。新增 DTO 是明确缺口。

---

## 3. artifact 注册流程（文件如何成为 artifact）

canonical 存储：`.pi-science/artifacts.jsonl`（workspace-local），读取经 `artifact-manifest.ts` 的 `normalizeManifest/collapseManifests` 归一化 v1→v2。

两条注册通道（都可复用给远程回收）：

1. 显式发布 `POST /api/artifacts/publish`（`apps/server/src/http/routes/artifact-routes.ts`）：
   - 校验路径在 workspace 内（`resolveWorkspaceFile`）、是文件、hash（sha256+size）、`artifact_id = sha256(cwd:relative) 前24位`。
   - 版本化：`newVersion = 同 artifact_id 最新版本+1`；hash 未变则 no-op 返回 existing。
   - 写入 manifest v2（含 `producer{tool,session_id,model,run_id}`、`environment`、`verification{status:passed,sha256}`），并在 `recordProvenance` 写 provenance（`provenance.jsonl`）。
   - 关系校验 `validateVersionedRelations`（inputs/supersedes 必须是同 workspace 已存在 manifest，≤100 个）。

2. turn 自动发现（`node-session-service.ts` `finishTurnArtifacts` + `workspace-artifact-snapshot.ts`）：
   - `agent_start` 记 baseline 快照，`agent_settled` 再快照 diff（created/modified），把 previewable 文件（有扩展名的 png/csv/md/…）标为 intermediate，写 turn-artifacts 记录 + publish `turn.artifacts` 事件。这只读可预览文件，不入 artifacts.jsonl 的正式 registry（区别于显式 publish）。
   - 相关：`node-event-observer.ts` 的 `observeWrittenArtifact` 会在 agent 写文件事件时发 artifact.published 事件。

含义：方案 4.5 的"回收文件自动注册为 artifact"最自然是走后端内部调用 publish 逻辑（复用 `resolveWorkspaceFile`+hash+artifact_id+写入 artifacts.jsonl），并以回收到的路径作为 publish 的 `path`，把 job 元数据放进 `environment`（或扩 producer）字段。跨 workspace 回收要小心 `resolveWorkspaceFile` 的 containment 校验。

---

## 4. 与方案 4.5 的差距（job lifecycle 各环节）

| 4.5 环节 | 现状 | 差距 |
|---|---|---|
| input manifest 与 hash | 无 input manifest/版本化打包；本地 job 只有 command+execution_cwd | 需设计输入列表→sha256 manifest |
| 本地 staging | 无 | 需新增：把输入收集到待传目录（或 manifest/dir） |
| 提交远端 | 无，`/api/compute/run` 是 stub | 需新增 SSH/Slurm 执行器 + 远端脚本封装（run.sh/wrapper 相应物） |
| 持久化 remote job ID | 无 | 需在 JobRecord（或新 RemoteJobRecord）加 remote_job_id + 远端信息 |
| 流式日志 | 本地有 `/api/jobs/:id/logs`（全量）；无实时流。SSE 基础设施在 `sse-routes.ts` | 需远端日志轮询/SSE 转发 |
| cancel 与断线 reconcile | 本地 cancel+孤儿接管很成熟；远程无 | 需远端子进程追踪、`scancel`/远端 kill、控制面重启后 reconcile 远端 job |
| 按 output glob 回收 | 无 | 需声明 output_glob → scp/rsync 拉回 → 落 workspace |
| 回收文件自动注册 artifact | 有 publish 通道（见 §3）可复用 | 需把回收文件喂进 publish + job→artifact 关联 |
| provenance（主机/provider/环境/jobID/输入版本/提交脚本/退出码/资源） | artifacts manifest 有 environment(任意 object) 与 producer；无 remote 专门字段 | 需在 manifest 或 provenance 记录补 remote/host/provider/job/exit/resource |

明确未实现项（docs §14.3 已列）：远程 SSH Job Lifecycle 属于路线图 Medium investment #5（`docs §9`），当前为空白。

---

## 5. 实现建议

### 5.1 服务端新增（核心）
1. 远程执行器（SSHEXecutor）——新增模块，建议 `apps/server/src/runtime/remote/ssh-executor.ts`（或扩展 catalog-routes 的 probe 逻辑成可复用 lib）：
   - 复用 catalog-routes 的 SSH 参数拼装、key/password 鉴权、host 校验、sshpass ENOENT 处理。抽成 `runRemote(cwd, machine, script, opts)` 供 probe/submit/logs/cancel/harvest 共用。
   - 密码鉴权：应仿照现状不落盘，probe 时由请求体或受控密钥环提供；提交远程 job 需设计凭据来源（内存密钥环/env/提示），避免明文入 .compute.json。
2. 远程 Job 状态机 / RemoteJobRecord：在本地 `JobRecord` 基础上扩展（或新增 parallel record），增加 `remote_job_id`、`provider`(ssh/slurm)、`host`、`user`、`staging_dir`、`remote_script`、`input_manifest`(含 hash)、`output_glob`、`exit_code`、`resources`。建议沿用 `.pi-science/jobs/<id>.json` + `withFileWriteLock` 同一持久化范式，复用 `healOrphan` 的断线模型——把"远端 job 存活判断"从本机 `process.kill(pid)` 换成"SSH 查询 job/进程状态"。
3. 状态机与 reconcile：
   - 复用现有 `JobStatus` + `submit/list/get/cancel/logs` 的 job-routes API 形状，把 `/api/compute/run` 从 stub 换成调用远程执行器。
   - 断线 reconcile：仿照 `healOrphan` 在 `list/get` 时探测远端（SSH ps / squeue）以收敛 pending/running 记录；控制面重启后靠持久化 remote_job_id + 远端探测恢复。
4. staging：新增本地 staging——把输入文件/脚本收集到 `.pi-science/staging/<jobid>/`（或 workspace 内临时目录），生成 input manifest（文件→sha256→打包），再 rsync/scp 上传。
5. 日志流：远端 job 轮询日志增量，通过 `/api/jobs/:id/logs`（累积）并复用 `sse-routes.ts` 的 SSE 通道做实时流（现有 SSE backpressure buffer 可直接复用）。
6. 回收（harvest）：按 `output_glob` 拉回文件到 workspace 目标目录（scp/套 glob），后接 publish。
7. 回收→artifact 自动注册：内部调用 publish 逻辑（复用 `resolveWorkspaceFile`+hash+artifact_id+写 `.pi-science/artifacts.jsonl`），回收路径即 artifact path；把 remote job 元数据写入 `environment`，或扩 `producer` 增加 host/job_id/provider/exit。明细对应 provenance（含退出码、资源使用）写到 provenance.jsonl。注意回收落到 workspace 内 + 限制 allowed glob，防路径逃逸。
8. 控制器接线：`registerCatalogRoutes(app, jobs, research)` 已把 JobCoordinator 传入；把远程执行器挂到 `jobs` 或独立 `RemoteJobCoordinator`，在 `app.ts` / `server-modules.ts` 构造。

### 5.2 前端改什么
- ComputeSettings.tsx：新增 job 管理区（提交表单：选择 machine、命令/脚本、input、output_glob、执行目录、超时）＋ job 列表＋状态/日志/cancel。复用现有 `apiRequest`/queryClient 模式。
- 新增 i18n key（`settings.computePage.*` 扩展 + 新 job 文案）。
- 产物展示：回收后出的 artifact 走现有 TurnArtifactStrip / ArtifactInspector / ProvenancePanel 即可，无需新大组件；可在 Provenance 增加 remote 域。

### 5.3 复用的现有代码（明确）
- `JobCoordinator` 的 JobStatus 状态机/持久化/锁/孤儿模型。
- `job-routes.ts` 的 API 形状（`/api/jobs` 链路）+ `publicJobRecord`（剥离 ownership）。
- `catalog-routes.ts` 的 SSH 探测逻辑（参数/鉴权/校验/超时）——这是最接近 SSH 执行器的现存代码。
- 本地 `terminate()` 进程组逻辑可映射到远端 cancel 语义。
- artifact publish/verify/lineage（`artifact-routes.ts`、`artifact-manifest.ts`）+ manifest v2 的 `environment` 字段（放 remote 元数据）。
- `sse-routes.ts` 的 SSE backpressure/流式通道。
- `workspace-security.ts` 的 `validateWorkspaceCwd`（所有路由已用）。

### 5.4 风险点
- 凭据管理：密码不入库是现状原则；远程执行需要运行凭据，务必内存化/提示式，避免仿 `.compute.json` 明文。
- 远端残留与取消一致性（docs §11 已强调）：控制面断线/取消需能可靠终止远端进程（进程组/`scancel`），否则远端残留算力与孤儿资源。
- reconcile 误判：远端 job 状态探测失败（网络/超时）可能把 running 误判为 failed/cancelled——需区分"确认远端已结束"与"无法联通"，沿用本地 ownership fencing 思路但改为"远端存活查询"。
- 回收路径逃逸/glob 放大：output_glob 必须限制、拉回路径必须 `pathIsInside` 校验，配合 egress 审计（`egress-audit.ts` 已有 MCP/endpoint egress 记录，可扩展 compute egress）。
- provider 多态过早：方案明确"先完整单机 SSH，再 Slurm/GPU/managed"，避免一上来做多 provider 抽象（docs §4.5/§11、refactoring 规则）。
- 契约漂移：server JobRecord 与 contracts jobRecordSchema 不同源，新增 remote 字段时选一个权威源并同步 zod schema + 测试。

### 5.5 实现顺序建议（贴合 docs §9/§10）
先做窄闭环：① 抽出 SSH 执行器（复用 probe）→ ② `/api/compute/run` 实现极简 submit（staging manifest→scp→远端执行→持久化 remote id）→ ③ 日志/sse → ④ cancel＋断线 reconcile → ⑤ output_glob 回收 → ⑥ 回收→publish＋remote provenance。每步独立建/测。

---

## 6. 相关测试清单

现有可复用/参考：
- `apps/server/src/runtime/jobs/job-coordinator.test.ts`（本地状态机/孤儿/所有权/cancel 的完整覆盖，可作远程对照模板）。
- `apps/server/src/http/routes/business-routes.test.ts`：compute 相关测试在 152-183 行（machine CRUD 去密码、invalid port 400、invalid probe host）。
- `apps/server/src/http/routes/job-routes.test.ts`（job-routes 覆盖，含 traversal/404/cancel）。
- `apps/server/src/http/routes/artifact-routes.test.ts`（publish/verify/lineage/版本化/跨 workspace 422）。
- `apps/server/src/runtime/artifacts/artifact-manifest.test.ts`、`workspace-artifact-snapshot.test.ts`。
- `apps/server/src/http/runtime-boundaries.ts`（`/api/compute`、`/api/jobs` 归属已声明）。
- 前端：`frontend/src/lib/conversation/todos.test.ts`（compute 仅在 query-client key 提及）。

4.5 新增测试建议（未实现，需补）：
1. SSH executor 单元测试——mock 系统 ssh/sshpass spawn（仿 catalog probe 测试，含 key 缺失、sshpass ENOENT、超时、host 校验、exit code）。
2. remote submit——`/api/compute/run` 返回持久化 `remote_job_id`、输入 manifest hash、pending→running 状态；staging 目录生成与上传命令断言。
3. reconcile——控制面重启后读取持久化 remote_job_id 并远端探测；"无法联通"与"确认结束"两种分支。
4. cancel——远端 terminate 命令发出 + 记录 cancelled + 无残留断言。
5. output_glob 回收——glob 拉回、路径 containment 校验、非匹配文件不收。
6. 回收→artifact——回收文件 publish 后出现在 artifacts.jsonl、lineage 指向 job 产出、provenance 含 host/provider/job_id/exit。
7. 凭据安全——machine CRUD 继续不落盘密码；运行凭据内存化不序列化。
8. 前端——ComputeSettings job 区（提交/列表/日志/cancel）组件与 query 测试。
9. 边界——output_glob 路径逃逸 4xx、跨 workspace 引用 422、契约 zod 校验。