# 内置 Web Search & Fetch MCP

Pi-Science 固定依赖 `pi-web-access@0.40.0`，通过当前 Node 可执行文件运行内置启动器，先生成隔离配置，再导入 npm 发布包中的 `dist/mcp-cli.js`。开发模式与编译后的服务端均通过 Node 包解析器定位入口，不使用全局安装、`npx` 或 Pi Extension。入口不存在时，启动会报告明确错误。

## 使用与授权

在 **设置 → MCP** 中管理默认启用的 **Web Search & Fetch**（连接器 ID：`mcp_builtin_web_access`，名称：`web-access`）。现有设置页支持工具列表、连接测试、启停、工具过滤与项目授权，无需额外页面或端口。

| Agent 工具名 | 用途 |
| --- | --- |
| `mcp__web-access__web_search` | 通用网页搜索，返回来源链接与 responseId |
| `mcp__web-access__fetch_content` | 抓取网页或 PDF |
| `mcp__web-access__get_search_content` | 按 responseId 分页读取已有结果 |
| `mcp__web-access__source_check` | 收集支持或质疑论断的来源 |

Paper Search 适合 PubMed、arXiv 等结构化学术数据库检索；Web Access 适合一般网站、文档和来源核查。网页内容属于不可信外部材料，不应被当成系统指令。

默认使用既有 `ask` 审批。若要免逐次确认，在 MCP 设置中选择 `allow_all`，并将全局或项目中已有的显式 `ask` 改成 `allow`。显式 `deny` 始终有效。编辑全局单项授权会把确认模式切换为 `custom`，因此调整工具后可再次选择 `allow_all`。工具调用活动仍正常展示。

独立 MCP 入口不提供 Curator、Pi 摘要流程、浏览器 Cookie 授权参数或自动登录页面。无需为关闭 Curator 修改上游代码。

## Provider 与凭据

第一版沿用上游 Provider 自动选择；无 Key 时可以使用 Exa MCP 路径，实际可用性取决于网络与上游服务。没有新增 Provider 选择界面。

控制面将解析后的 Pi-Science 数据根目录作为该连接器独有的绝对路径参数写入启动命令。Worker 无需向普通工具开放 `PI_SCIENCE_HOME`，内置启动器也不依赖子进程环境变量来重新寻找数据根目录。内置启动器在该目录下生成独立的上游配置，不读取 `~/.pi/agent/web-search.json`、XDG 或其他 Pi Agent 的配置，即使父环境 / 连接器绑定了 `PI_CODING_AGENT_DIR` 也会覆盖为内置目录。

- 操作者配置：`<PI_SCIENCE_HOME>/mcp/web-access/config.json`（可选）。未设置 `PI_SCIENCE_HOME` 时使用 Pi-Science 的常规数据目录，通常为 `~/.pi-science`。
- 生成配置：同目录下 `runtime/web-search.json`，每次 MCP 子进程启动时重新生成，以仅当前用户可读写的文件权限保存（支持 POSIX 权限的平台）。不要直接编辑生成文件。
- 内置策略固定关闭 GitHub Clone / PR Issue 特殊处理，固定 `ssrf.allowRanges=[]`、`ssrf.trustEnvProxy=false`；四项上游工具始终开启，显隐和授权统一由 Pi-Science 管理。操作者配置中的这些字段不会覆盖内置策略。
- 操作者文件无效时启动明确失败，不回退读取其他 Pi 配置。Provider 等其他上游设置可在该文件中配置，修改后重启对应会话 / Worker 生效。

例如指定 Brave（不要在文件里写入真实密钥）：

```json
{
  "provider": "brave",
  "maxInlineContentChars": 12000
}
```

**配置 `BRAVE_API_KEY` 仅增加可用后端，不会自动选择 Brave**：`provider: auto` 会优先尝试 Exa，Exa 成功时不会调用 Brave。要默认使用 Brave，在上述操作者文件设置 `provider: "brave"`；也可以在单次 `web_search` / `source_check` 调用中明确传入 `provider: "brave"`。

Brave 的 API Key 可在现有 MCP 认证设置中存为托管凭据，或引用系统环境变量，目标变量选择 `BRAVE_API_KEY`。其他 Provider 可以使用相同入口指定其所需变量名，例如 `EXA_API_KEY`。只把相应凭据传给该连接器子进程；快照保存凭据引用，不能直接把 Key 写进 JSON 配置、源码或日志。Provider 配置字段以固定版本的上游 README 为准。

## 生命周期、缓存与文件

每个需要 Web Access 的 Worker 拥有独立 MCP 子进程。关闭客户端会关闭子进程；取消请求经官方 MCP SDK 传递给上游的请求信号。配置变更复用现有 runtime 刷新机制。

上游独立核心保留最近最多 50 个结果的进程内索引；重启后旧 responseId 不保证可用，也不保证跨 Worker 共享。发布包还包含抓取缓存与 PDF 文件写入路径：默认 PDF 输出位于系统临时目录的 `pi-web-pdf`，上游 GitHub 克隆路径为 `/tmp/pi-github-repos`，但本内置连接器关闭该功能。这些目录不属于 Pi-Science 持久化科研产物体系，不能以 responseId 替代原始 URL、访问时间、证据内容与哈希。需要长期复现的材料应另行保存到工作区。

## 安全验收边界

`runtime_config.allow_private=false` 控制连接器的传输目标，不能充当 stdio 子进程内部请求的统一网络沙箱。本集成没有改写上游，也没有新增进程网络沙箱。

已对实际 npm CLI 验证：默认配置下拒绝 loopback、RFC1918、链路本地 metadata、IPv6 loopback、`file:` URL；拒绝跳转到私网的重定向；拒绝声明超限长度的响应；取消可传至活动抓取并关闭进程。测试使用隔离配置和 HTTP 响应夹具，验证真实工具核心与协议，不依赖公网。

上线前仍需部署侧验收以下项目：

- **DNS rebinding / 代理**：上游 `validateRemoteUrl` 在请求前解析 DNS，随后由 fetch / 代理建立连接；没有看到将已检查地址固定到实际连接的保证。每跳重定向会再次检查，但不能据此宣称阻止 DNS rebinding。内置启动器固定关闭上游 SSRF 放行项；逐次 `proxy` 和部署代理仍需单独审查。若需要严格隔离，使用能检查实际连接目标的受限 egress proxy / 子进程沙箱。
- **资源限额**：上游有请求超时、正文 / PDF 大小限制与结果数限制；这不等于 OS 级内存、并发、下载总量或临时目录配额。大 PDF、流式超大正文、异常退出和重试仍需专项验收。
- **文件与可选功能**：本集成不将上游临时目录自动纳入 Workspace 边界。GitHub Clone / PR Issue 特殊处理在内置连接器中关闭；可选本地视频路径及操作者配置中的凭据命令来源仍需按部署要求审查。默认启用的工具仍经过 Pi-Science 授权。
- **凭据与外部材料**：凭据绑定与快照脱敏有回归测试；这不能替代所有 Provider 的跨域 Header / Cookie 泄漏测试或模型对 Prompt Injection 的端到端验证。

## 验证方法与记录

离线专项测试：

```bash
pnpm --filter @pi-science/server exec vitest run src/mcp/web-access.test.ts src/mcp/web-access-config.test.ts src/http/routes/mcp-routes.test.ts src/mcp/connector-service.test.ts src/runtime/agent/worker/mcp-tools.test.ts
```

编译后发布包握手、四项工具发现与关闭验证：

```bash
pnpm --filter @pi-science/contracts build
pnpm --filter @pi-science/server build
node apps/server/scripts/smoke-web-access.mjs
```

具备可访问上游的网络时运行真实搜索 → 抓取 → 分页：

```bash
node apps/server/scripts/smoke-web-access.mjs --live
```

`--live` 分别尝试真实 Exa 搜索与网页抓取，任何失败均以非零状态退出，不把网络错误视为成功。需要显式启用 Node 环境代理的部署可使用 `NODE_USE_ENV_PROXY=1`（PowerShell 使用相应环境变量语法）；应保留部署所配置的代理与 CA 信任。

2026-10-15 本地 Linux 验证中，开发 CLI 专项测试与编译入口握手通过。真实公网链路受当前环境限制：`mcp.exa.ai` 的代理 CONNECT 返回 403；`raw.githubusercontent.com` 在上游预检中出现 DNS `EAI_AGAIN`，因此没有将真实 Search → Fetch → 分页标为通过。未放宽 SSRF 配置来绕过这一限制。

本地项目验证记录（全量测试与控制面 smoke 为初版记录；review 修复后重跑了 MCP 专项、类型检查、完整构建与编译后 Web Access smoke）：

| 检查 | 结果 |
| --- | --- |
| Web Access、MCP 路由、连接器服务及 Worker MCP 回归 | 5 个文件、25 项测试通过（含自定义数据根目录的真实 Worker 链路） |
| Agent Core 终态恢复回归 | 8 项测试通过；故障注入仅丢弃原始事件，保留 watchdog 合成恢复事件 |
| Contracts 测试 | 2 个文件、15 项通过 |
| 服务端全量测试 | 109 个文件、921 项通过；1 个文件、15 项跳过 |
| 前端全量测试 | 167 个文件、1637 项通过 |
| Skills 测试 | 5 个文件、28 项通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过；前端仍有现有的大 chunk 提示 |
| 编译后 Web Access CLI smoke | 通过 |
| `NODE_USE_ENV_PROXY=1 pnpm smoke` | 通过 |
| `NODE_USE_ENV_PROXY=1 pnpm smoke:agent-core` | 通过 |

两项控制面 smoke 首次运行因 Micromamba 下载失败而在 `/api/jobs` 返回 400；按当前环境配置启用 Node 代理后均通过，没有改动业务代码来跳过环境初始化。

全量入口 `pnpm test` 的最终一轮完成 Contracts / 服务端后进入前端；因前端与 Skills 已通过相同分包命令单独验证，停止了这轮重复执行。上表记录各分包实际通过结果，不把被停止的聚合命令标为成功退出。

CI 在 Linux / Windows 的常规验证及 macOS 的专项步骤中运行发布 CLI 测试和编译入口 smoke；本地 Linux 的结果不能代表其他平台的 CI 已运行通过。

回滚时可在设置中停用 `web-access`；代码回滚只需移除内置注册与固定依赖，保留其他 MCP 数据。
