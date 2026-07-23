# Pi-Science Node/TypeScript 后端迁移原子级方案

**状态：** 迁移与真实 Pi/UI 验收已完成（2026-07-24）；仅 Python 兼容控制面删除保留为发布周期门槛
**目标：** 将 Pi-Science 的控制面逐步迁移到 Node.js/TypeScript，同时保留 Python 作为科研计算运行时。每个任务必须可独立合并、可独立验收、可快速回滚。

## 1. 目标架构

```text
React / Vite :5173
        |
        | HTTP + SSE
        v
Node.js / TypeScript control plane :8787
        |
        | internal HTTP
        v
Python scientific runtime :8788
        |
        +-- Python/R kernels
        +-- notebooks/Jupyter
        +-- PDF、figure、literature 与科学计算
```

Node 最终负责：公共 API、认证与配置、会话、SSE、Pi 子进程、工作区安全、文件流、任务调度、产物和项目记忆。

Python 长期负责：kernel、notebook、PDF/figure、科学库调用、Python/R 环境和需要 Python 生态的计算。

## 2. 原子任务统一约束

每个原子 PR 必须满足：

1. 只迁移一个明确能力或增加一个基础设施能力。
2. 不同时重构前端、Node 和 Python 中无关代码。
3. 新 Node 路由上线前，先补共享 Zod 契约和兼容测试。
4. 同一路由只能有一个写入主节点，禁止 Node/Python 双写。
5. 迁移期间保留 Python 回退开关。
6. 每个 PR 都必须通过单元测试、类型检查和相关 smoke 用例。
7. 回滚必须只需要恢复路由所有权或关闭 feature flag，不要求数据回迁。

统一完成定义：

```bash
pnpm typecheck
pnpm --filter @pi-science/contracts test
pnpm --filter @pi-science/server test
pnpm --filter frontend test
pnpm build
uv run pytest backend/tests -q
bash scripts/smoke-control-plane.sh
PI_CLI_PATH=/absolute/path/to/pi pnpm smoke:real-pi
pnpm uat:conversation
```

## 3. 阶段与原子 PR

### Phase 0：固化 Node 网关基线

#### NCP-001：提交 workspace 与 Node gateway 骨架

- 范围：根级 `package.json`、`pnpm-workspace.yaml`、`apps/server/`、`packages/contracts/`。
- 交付：Node 在 `8787` 提供健康检查，并代理 Python `8788`。
- 验收：类型检查、gateway 单测、contracts 单测、Node build 通过。
- 回滚：删除 workspace 新增文件，恢复 Python 监听 `8787`。
- 状态：已实现并通过完整验收。

#### NCP-002：固化双运行时启动与关闭

- 范围：`scripts/dev.sh`。
- 交付：按 Python → Node → frontend 顺序启动；任一进程失败时整体退出；Ctrl+C 清理三个子进程。
- 验收：端口冲突会明确失败；正常退出后 `5173/8787/8788` 无本项目残留监听。
- 回滚：恢复原单 Python backend 启动流程。
- 状态：已实现；启动、端口、清理、baseline smoke、真实 Pi smoke 和浏览器 UAT 已覆盖。

#### NCP-003：增加公共 readiness 与内部 liveness

- 新增：`GET /api/health`、`GET /internal/live`、`GET /internal/ready`。
- readiness 必须检查 Python runtime；liveness 只检查 Node 事件循环。
- 内部端点默认只绑定 loopback，不经过前端代理。
- 验收：Python 停止后 liveness 为 200，readiness 和公共 health 为 503。
- 回滚：移除内部端点，不影响兼容代理。

#### NCP-004：建立路由所有权注册表

- 范围：`apps/server/src/runtime-boundaries.ts`。
- 将 route group、当前 owner、目标 owner、fallback 开关集中声明。
- 未登记的 `/api` 路由启动时产生 warning，测试环境直接失败。
- 验收：所有 FastAPI router 都在注册表中出现；不存在模糊默认所有权。
- 回滚：恢复当前 prefix 判定。

#### NCP-005：增加代理安全与可观测性

- 添加 request ID、上游耗时、超时、body size 限制和结构化错误。
- 不记录 API key、Authorization、prompt 全文和文件内容。
- 验收：上游超时返回稳定的 504 contract；日志包含 request ID 和 route owner。
- 回滚：保留基础 proxy，关闭增强 hooks。

### Phase 1：契约、测试和发布护栏

#### NCP-006：补齐共享 API contracts

- 从前端实际使用的类型开始：session、workspace、file、job、artifact、event。
- Zod schema 是跨运行时 contract，Python 响应通过 contract fixture 验证。
- 验收：关键 Python 响应 fixture 全部能被 schema parse；破坏字段会使测试失败。
- 回滚：contracts 只用于验证，不改变运行时行为。

#### NCP-007：实现 Python/Node contract parity 测试

- 对相同请求分别调用 Python 直连和 Node 代理。
- 比较状态码、关键 header、JSON shape、SSE framing。
- 忽略时间戳、request ID 等非确定字段。
- 验收：session、workspace、file、settings、kernel 五组 parity 测试通过。
- 回滚：测试文件可独立移除。

#### NCP-008：落地 control-plane smoke 脚本

- 新增 `scripts/smoke-control-plane.sh`。
- 脚本负责启动临时 Python/Node 端口、轮询 readiness、执行 smoke、清理进程。
- 使用临时 `PI_SCIENCE_HOME` 和 workspace，禁止读取用户真实项目数据。
- 验收：本地和 CI 均可单命令运行，失败返回非零退出码。
- 回滚：不影响产品运行时。

#### NCP-009：CI 增加 Node migration gate

- CI 顺序：contracts → server typecheck/test/build → Python tests → frontend tests → smoke。
- 保存失败时的 Node/Python 日志，但先执行 secret redaction。
- 验收：人为破坏代理 header、SSE 或 readiness 时 CI 必须失败。
- 回滚：仅移除新增 job。

### Phase 2：迁移 sessions 与 SSE

#### NCP-010：迁移只读 session repository

- TypeScript 读取现有 JSONL/session 文件，保持原目录格式不变。
- 首批迁移：list session、history、state、export 的只读部分。
- Python 保持写入方。
- 验收：同一 fixture 下 Node/Python 返回语义一致；非法 cwd 被拒绝。
- 回滚：route owner 切回 Python，无数据迁移。

#### NCP-011：建立 Node durable event store

- 定义单调递增 cursor、event envelope、replay window 和截断策略。
- 先镜像 Python 事件，不切换前端消费端。
- 验收：进程重启后 cursor 可恢复；重复事件不会重复落盘。
- 回滚：停止镜像，Python event stream 不受影响。

#### NCP-012：迁移 SSE broker

- Node 负责浏览器连接、heartbeat、断线重连、`Last-Event-ID` replay。
- Python/Pi 事件通过内部 adapter 输入 broker。
- 验收：中断并重连后不丢事件、不重复 terminal event；慢客户端有背压上限。
- 回滚：`PI_SCIENCE_NODE_SSE=0` 切回 Python SSE。

#### NCP-013：迁移 session command API

- 逐个迁移 prompt、abort、compact、model、interaction response。
- 每个 command 使用 idempotency key，避免重试造成重复执行。
- 验收：每个 command 都有 success、invalid state、runtime unavailable 测试。
- 回滚：按 route group 切回 Python。

#### NCP-014：关闭 Python 公共 session 路由

- Python session API 改为 internal-only，或要求内部认证 header。
- Node 成为 session 唯一公共入口。
- 验收：浏览器无法直连 Python session API；Node 正常工作。
- 回滚：恢复 Python public flag。

### Phase 3：迁移 Pi 子进程管理

#### NCP-015：提取 Pi JSONL RPC contract

- 将 spawn 参数、command、event、error、exit reason 定义为共享 schema。
- 基于真实录制 fixture 测试 normal、malformed、partial line 和 crash。
- 验收：解析器不因单个坏事件终止整个会话，错误有明确分类。
- 回滚：仅新增 contract 与 adapter，不切 owner。

#### NCP-016：实现 Node PiProcess 单会话管理

- 支持 spawn、stdin command、stdout JSONL、stderr、abort、graceful shutdown。
- 设置最大行长度、事件大小、启动超时和退出超时。
- 验收：正常对话、启动失败、强制终止、子进程崩溃测试通过。
- 回滚：feature flag 切回 Python `PiProcess`。

#### NCP-017：实现 Node PiManager 多会话管理

- 管理 session → process 映射、并发上限、重复启动、shutdown all。
- 进程退出必须清理引用并产生 terminal event。
- 验收：并发会话隔离；一个 Pi 崩溃不影响其他会话。
- 回滚：切回 Python manager，不改变磁盘 session 格式。

#### NCP-018：切换 session commands 到 Node PiManager

- Node 成为 Pi command 唯一写入方。
- Python 不再持有 Pi 子进程，仅保留 scientific runtime。
- 验收：完整 session lifecycle smoke 通过；Python health 中 Pi count 可废弃或固定为 0。
- 回滚：版本发布前保留单一开关恢复 Python manager，禁止双 manager 同时启用。

### Phase 4：工作区与文件控制面

#### NCP-019：迁移 workspace registry 与路径安全

- TypeScript 实现 canonical path、注册表、允许根目录和 symlink escape 防护。
- 使用同一组跨语言安全 fixture。
- 验收：`..`、绝对路径绕过、symlink escape、编码路径攻击全部拒绝。
- 回滚：切回 Python workspace routes。

#### NCP-020：迁移只读文件 API

- 迁移 list、stat、read、preview metadata、breadcrumbs。
- 大文件必须流式返回，不一次性读入内存。
- 验收：文本、二进制、Unicode 文件名、大文件、range request smoke 通过。
- 回滚：切回 Python file routes。

#### NCP-021：迁移文件写操作

- 迁移 upload、rename、move、delete；所有操作进入 provenance/journal。
- delete 优先采用可恢复策略；跨设备 move 有明确失败行为。
- 验收：写入原子性、冲突、权限错误和 undo 路径测试通过。
- 回滚：切回 Python，磁盘格式保持兼容。

### Phase 5：迁移业务控制面

以下每项必须独立 PR，不合并为一次大迁移：

#### NCP-022：settings、model registry 与 endpoint 配置

- API key 继续使用受控存储，响应永不返回明文。
- smoke：新增、读取掩码、删除 key；环境变量优先级可预测。

#### NCP-023：skills 与 MCP catalog

- Node 负责 catalog、启停、schema 校验；工具执行可继续由对应 runtime 完成。
- smoke：catalog list、toggle、非法 manifest、不可用 MCP 状态。

#### NCP-024：jobs 与 artifact metadata

- Node 负责任务状态机和 artifact 索引；Python worker 执行科学任务。
- smoke：queued → running → succeeded/failed/cancelled，重启后状态可恢复。

#### NCP-025：provenance、runs、citations 与 reviews

- 采用 append-only record + projection，确保写入顺序和可追踪性。
- smoke：创建 run、追加记录、读取关联、损坏尾行恢复。

#### NCP-026：project knowledge 与 project memory

- Node 负责事务边界、版本和并发控制；AI 调用通过 provider adapter。
- smoke：创建、更新、版本恢复、proposal accept/reject、并发冲突。

#### NCP-027：compute machine registry 与 remote dispatch

- Node 保存机器配置和调度；Python 执行本地科学 probe。
- smoke：机器 CRUD、连接失败、取消、日志和 artifact 回传。

### Phase 6：收缩 Python 公共面

#### NCP-028：Python internal API 鉴权

- Python 只接受 loopback，并要求 Node 注入的短期内部 token。
- `/docs` 默认不公开 Python 全量内部 API。
- 验收：无 token 直连返回 401/403；Node 代理正常。

#### NCP-029：删除已迁移 Python control-plane 代码

- 每次只删除已稳定运行至少一个发布周期的 route group。
- 删除前确认不存在前端直连、脚本调用和测试 fixture 依赖。
- 验收：route inventory、静态搜索和 smoke 均确认无调用。

#### NCP-030：完成 ownership audit

- Python 最终仅保留 kernels、notebooks、PDF/figure、literature 和科学计算接口。
- Node 对所有公共 `/api` 路由负责。
- 验收：route registry 只保留 kernels、notebooks、pdfs、figures、literature 五类 Python scientific compatibility routes，架构文档与代码一致。

## 4. Smoke 测试方案

### 4.1 Smoke 环境原则

- 使用临时数据目录和临时 workspace。
- 使用动态空闲端口，避免干扰开发者已有的 `8787` 服务。
- 默认使用 fake Pi runtime；真实 Pi smoke 作为单独可选测试。
- 每个测试设置 5～15 秒硬超时，禁止无限等待。
- 退出时无论成功失败都清理 Node、Python 和子进程。
- 日志中对 API key、Authorization 和用户内容进行脱敏。

### 4.2 基线 smoke 用例

| ID | 场景 | 操作 | 通过标准 |
|---|---|---|---|
| SMK-001 | Node liveness | 仅启动 Node | `/internal/live` 返回 200 |
| SMK-002 | Runtime degraded | Node 指向不可用 Python | `/api/health` 返回 503，Node 不退出 |
| SMK-003 | Gateway ready | 启动 Python 和 Node | `/api/health` 返回 200 且 `control_plane=node` |
| SMK-004 | GET proxy | 请求 `/api/settings/config` | 状态和 JSON 正常，包含 upstream header |
| SMK-005 | POST proxy | 创建临时 workspace 或 session fixture | body、状态码和响应完整转发 |
| SMK-006 | Runtime ownership | 请求 `/api/kernels/status` | header 标记 `python-scientific-runtime` |
| SMK-007 | SSE framing | 连接 session event fixture | `id/event/data` 边界不被缓冲或破坏 |
| SMK-008 | SSE replay | 带 `Last-Event-ID` 重连 | 从下一 cursor 继续，无重复 terminal event |
| SMK-009 | OpenAPI/docs | 请求 `/openapi.json` 和 `/docs` | 代理可访问且 content type 正确 |
| SMK-010 | CORS | 使用允许和不允许的 Origin | 允许列表正确，不反射任意 Origin |
| SMK-011 | Body limit | 上传超限 payload | 返回 413，不拖垮 Node |
| SMK-012 | Upstream timeout | Python handler 故意超时 | 返回稳定 504 contract，日志含 request ID |
| SMK-013 | Graceful shutdown | 终止启动脚本 | 子进程清理完成，临时端口释放 |
| SMK-014 | Frontend route | 通过 Vite 请求 API | 浏览器路径只访问 Node，不直连 Python |
| SMK-015 | Workspace escape | 请求 `../` 和 symlink escape | 返回 4xx，不读取允许根外文件 |

### 4.3 Session/Pi 迁移后的 smoke

| ID | 场景 | 通过标准 |
|---|---|---|
| SMK-101 | Create session | 返回 session ID，磁盘 manifest 可读 |
| SMK-102 | Send prompt | fake Pi 收到一次 command，事件流返回文本和 idle |
| SMK-103 | Abort | streaming 状态结束，产生明确 terminal event |
| SMK-104 | Reconnect | SSE 断开后 replay 不丢事件 |
| SMK-105 | Pi crash | 单会话进入 error，Node 和其他会话保持可用 |
| SMK-106 | Restart recovery | Node 重启后历史、cursor 和 session state 可恢复 |
| SMK-107 | Concurrent sessions | 两会话事件、cwd、model 和进程互不串扰 |
| SMK-108 | Duplicate command | 相同 idempotency key 只执行一次 |
| SMK-109 | Session switch | 创建 A、B 后依次读取 A、B state | Pi 原子切换且都返回原 session ID |
| SMK-110 | Fork | 对 B 执行 fork | 返回不同 ID，header owner 为 `node-control-plane` |
| SMK-111 | Exact delete | 删除 fork、B、A | 每次返回 `ok=true`，删除后 state 为 404 |
| SMK-112 | Native ownership | create/state/prompt/fork/delete/health/SSE | HTTP owner 全为 Node，SSE 为 `node-native` |
| SMK-113 | Prompt terminal | Pi state 有 model 时发送 prompt | SSE 最终出现 `session.idle` 或明确 `error` |

### 4.4 Workspace/File 迁移后的 smoke

| ID | 场景 | 通过标准 |
|---|---|---|
| SMK-201 | Register workspace | 合法目录注册并可重复调用 |
| SMK-202 | List/read file | Unicode 和空格路径正确处理 |
| SMK-203 | Large file | 流式返回，Node 内存不随文件大小线性增长 |
| SMK-204 | Upload/rename | 内容完整，冲突返回确定错误 |
| SMK-205 | Delete/undo | 删除有 journal/provenance，支持约定的恢复路径 |
| SMK-206 | Path traversal | 编码和未编码 traversal 均被拒绝 |

### 4.5 推荐 smoke 脚本接口

```bash
# 全部基线 smoke
bash scripts/smoke-control-plane.sh

# 只验证网关，不启动前端
bash scripts/smoke-control-plane.sh --gateway-only

# 开启 Node sessions/files feature flags 验证原生只读路由
bash scripts/smoke-control-plane.sh --native-readonly

# 启用真实 Pi runtime
bash scripts/smoke-control-plane.sh --real-pi

# 等价的 package 入口
PI_CLI_PATH=/absolute/path/to/pi pnpm smoke:real-pi

# 对已启动的前后端运行浏览器对话 UAT
pnpm uat:conversation

# 保留失败现场和日志
bash scripts/smoke-control-plane.sh --keep-temp
```

脚本内部建议使用以下退出码：

- `0`：全部通过。
- `10`：环境或依赖缺失。
- `20`：Python runtime 启动失败。
- `30`：Node control plane 启动失败。
- `40`：HTTP/contract smoke 失败。
- `50`：SSE 或真实 Pi lifecycle smoke 失败。
- `60`：清理或进程泄漏失败。

## 5. 发布与回滚策略

迁移开关建议按 route group 设置：

```text
PI_SCIENCE_NODE_SESSIONS=0|1
PI_SCIENCE_NODE_SSE=0|1
PI_SCIENCE_NODE_PI_MANAGER=0|1
PI_SCIENCE_NODE_WORKSPACES=0|1
PI_SCIENCE_NODE_FILES=0|1
PI_SCIENCE_NODE_JOBS=0|1
PI_SCIENCE_NODE_ARTIFACTS=0|1
PI_SCIENCE_NODE_SETTINGS=0|1
PI_SCIENCE_NODE_CATALOG=0|1
PI_SCIENCE_NODE_PROJECT=0|1
```

规则：

1. 当前各 Node owner 默认开启；兼容开关只用于按 route group 回滚和故障隔离。
2. Python 旧 control-plane 代码保留一个稳定发布周期，但默认不拥有公共写路径。
3. 写操作始终必须是单一 owner，禁止 Node/Python 双写。
4. 出现数据一致性问题时关闭对应 route group，不影响其他已迁移模块。
5. 删除 Python 旧实现前，必须再次完成 ownership audit、静态调用扫描和完整 smoke。

## 6. 历史执行顺序与后续发布门槛

迁移按以下顺序完成：基础网关与发布护栏（NCP-001～NCP-009）→ sessions/SSE（NCP-010～NCP-014）→ Pi 子进程管理（NCP-015～NCP-018）→ 工作区与文件安全边界（NCP-019～NCP-021）→ 业务控制面（NCP-022～NCP-027）→ Python 公共面收缩与 ownership audit（NCP-028～NCP-030）。

当前已落地：Node gateway、readiness/liveness、route registry、共享 contracts、proxy parity、完整 session/Pi 生命周期、durable event store、Node-native SSE、workspace/file 写入、settings/provider 和业务控制面。相关能力保留按 route group 回滚的 feature flag；只有 NCP-029 仍需等待一个稳定发布周期后删除 Python 旧 control-plane 兼容代码。

### 当前执行状态

| 原子任务 | 状态 | 备注 |
|---|---|---|
| NCP-001～NCP-009 | 已完成 | 网关、contracts、代理护栏、smoke、CI 已落地 |
| NCP-010～NCP-012 | 已完成 | JSONL session read、durable event store、Node-native SSE/replay 已落地 |
| NCP-013～NCP-018 | 已完成 | prompt/abort/model/compact/fork/interaction、Pi JSONL adapter、PiManager 已实现；Node 模式禁止 session/SSE 写路径回落 Python |
| NCP-019～NCP-021 | 已完成 | workspace 安全、流式只读、upload/move/rename/delete、provenance journal 已落地 |
| NCP-022～NCP-026 | 已完成 | settings/catalog、jobs/artifacts、provenance/runs、project knowledge/memory 已由 Node 默认负责 |
| NCP-027 | 已完成（registry-first） | Node 保存 machine registry；远程 executor 未配置时明确拒绝，不伪造成功 |
| NCP-028 | 已完成（可选强制） | token-only Python internal boundary、Node 注入、直连 403 smoke 已落地 |
| NCP-029 | release-gated | Python 旧 control-plane 模块仍保留作可回滚兼容实现，待一个稳定发布周期后删除 |
| NCP-030 | 已完成 | ownership registry 仅保留 kernels/notebooks/pdfs/figures/literature 五组 Python scientific routes |

当前自动验收入口已覆盖：浏览器只连接 Node；真实 Pi 的 create/state/SSE、可用模型下的 prompt terminal、会话切换、fork、精确 delete，以及 health/session owner header。Python 在 smoke/dev split runtime 中作为受 token 保护的内部 scientific service 存在。NCP-029 是有意保留的可回滚发布门槛，不是双写。

### 2026-07-24 最终验收快照

| 验收项 | 结果 |
|---|---|
| Node typecheck | 通过 |
| Node server tests | 10 files / 49 passed |
| Frontend tests | 10 files / 68 passed |
| Python tests | 266 passed / 21 skipped |
| Production build | 通过 |
| `pnpm smoke` | 通过，包含无 Key 自定义 provider |
| `PI_CLI_PATH=... pnpm smoke:real-pi` | 通过，覆盖 Node-native SSE、prompt terminal、A→B→A、fork、delete、health owner |
| `pnpm uat:conversation` | 通过；无模型时验证明确禁用，配置模型时执行 streamed prompt 分支 |

本轮额外完成了 timeout/cancelled/reconciliation/restart 的故障原子性、
replay/live 去重、有限 SSE 背压、CRLF 解析、`text_end` 最终快照、
tool-only turn、artifact/idle 顺序、cursor gap 恢复、精确 provider 错误、
REST/SSE session replacement、custom provider 保存刷新和 workspace-scoped
Pi 配置目录。默认 Node-native 模式下不会读取或写入用户的 `~/.pi/agent`。

兼容模式的已知非阻断项：当 `PI_SCIENCE_NODE_PI_MANAGER=0` 时，每个浏览器
标签仍会建立独立 Python SSE 上游连接，但持久化前已有幂等去重。默认
Node-native 模式使用中央 hub，不受此项影响。
