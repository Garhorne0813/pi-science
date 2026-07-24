# Pi-Science Bug 修复执行计划

## 目标

修复代码审查发现的安全、数据一致性、并发和资源使用问题，并补充回归测试。执行过程中不得削弱现有 workspace 隔离、artifact 校验、SSE 顺序保证和运行时生命周期管理。

## 当前基线

- contracts 测试：2 项通过
- Node server 测试：51 项通过
- frontend 测试：68 项通过
- TypeScript typecheck：通过
- 全项目 build：通过
- Python 测试：已收集 288 项，但当前执行器未取得完整最终摘要；修复后必须重新运行并记录最终结果

执行前先确认工作区状态，不要覆盖已有用户修改。CodeGraph 已建立索引；定位代码时优先使用：

```bash
codegraph explore "<问题或符号>"
codegraph node "<符号>"
```

## 执行规则

1. 先为每个 bug 编写失败测试，再实现修复。
2. 保持 API 兼容；若必须改变响应，补充 contracts 或 API 测试。
3. 不要通过放宽校验来使测试通过。
4. 所有外部 URL、workspace 路径、文件路径和用户输入都必须经过明确校验。
5. 修复后运行相关测试、完整测试、typecheck 和 build。
6. 最终报告列出改动文件、测试命令、测试结果和未解决风险。

## P1：必须修复

### BUG-001：自定义模型发现存在 SSRF

证据：`apps/server/src/settings-routes.ts:44`。

`/api/settings/custom-providers/discover` 只检查 URL 是否为 `http(s)`，然后由服务端请求 `${baseUrl}/models`。这允许访问 localhost、私网、链路本地地址、云实例元数据服务或通过重定向访问这些地址。

#### 修复要求

- 抽取统一的 outbound URL 校验器。
- 拒绝 loopback、私网、链路本地、广播、保留地址和 IPv4-mapped IPv6 地址。
- DNS 解析后校验实际 IP；不能只校验 URL 字符串。
- 禁止自动重定向，或对每个重定向目标重新校验。
- 保留连接、响应和响应体大小限制。
- 优先接入现有 egress policy/gateway；不要在路由中重复实现一套不一致的策略。
- 不得把 API key 放入错误消息、日志或响应体。

#### 必须添加的测试

- `http://127.0.0.1`
- `http://localhost`
- `http://169.254.169.254`
- 私网 IPv4 和 IPv6 地址
- DNS 解析到私网地址
- 公网地址重定向到私网地址
- 公网 HTTPS provider 正常发现模型
- 超时和过大响应被拒绝

### BUG-002：subagents 接口绕过 workspace 校验

证据：`apps/server/src/settings-routes.ts:54`。

`/api/settings/subagents?cwd=...` 直接拼接 `cwd/.pi/agents`，没有调用 `validateWorkspaceCwd`，可枚举任意目录中的 Markdown 文件名和绝对路径。

#### 修复要求

- 使用 `validateWorkspaceCwd` 验证 cwd。
- 只允许注册 workspace。
- 响应中的 path 使用 workspace-relative path，避免暴露主机绝对路径。
- 无效 workspace 返回一致的 403 错误。

#### 必须添加的测试

- 未注册 cwd 返回 403。
- 注册 workspace 可以列出 agents。
- `cwd=..`、绝对系统路径和 symlink escape 被拒绝。
- 响应不包含绝对文件系统路径。

### BUG-003：job_id 路径穿越

证据：`apps/server/src/job-routes.ts:29`、`104-106`。

`jobPath()` 将 URL 参数直接拼接为文件名。GET、DELETE 和 logs 接口都使用该函数，缺少 job ID 格式校验和最终路径 containment 校验。

#### 修复要求

- 只接受服务端生成的格式，例如 `job_` 加 16 位字母数字。
- `jobPath` 内部必须做格式校验。
- 即使格式校验存在，也要对最终路径执行 workspace/jobs containment 检查。
- DELETE 不得覆盖 jobs 目录外的文件。

#### 必须添加的测试

- `../config`、`../../config` 和 URL encoded traversal 均返回 400/404。
- 不可读取 `.pi-science` 下的其他 metadata 文件。
- 不可通过 DELETE 覆盖 metadata 文件。
- 正常生成的 job ID 仍可查询、删除和读取日志。

### BUG-004：job 取消状态被后台任务覆盖

证据：`apps/server/src/job-routes.ts:52-77` 与 `105`。

DELETE 将记录写为 `cancelled`，但后台 `run()` 在子进程退出后会再次写入 `succeeded` 或 `failed`。

#### 修复要求

- 建立显式终态状态机。
- 取消后，后台收尾逻辑不得覆盖 `cancelled`。
- 取消操作幂等。
- 终止时处理子进程树，而不只是直接 child。
- 必须避免并发写入导致旧状态覆盖新状态；必要时使用版本号或 per-job 串行队列。

#### 必须添加的测试

- 运行 `sleep` 类长任务，DELETE 后最终状态仍为 `cancelled`。
- pending job 在启动前取消不会执行命令。
- 重复 DELETE 不改变结果。
- 子进程退出事件晚于 DELETE 时仍保持 cancelled。
- 超时仍返回 `timed_out`，不能误报 cancelled 或 succeeded。

## P2：应修复

### BUG-005：Node artifact 发布无大小上限且一次性读入内存

证据：`apps/server/src/artifact-routes.ts:29`。

Node 路由直接 `readFile(target)`，而 Python artifact store 已有 `_MAX_PUBLISH_BYTES`。两套实现行为不一致，超大文件可能耗尽 Node 进程内存。

#### 修复要求

- 使用流式读取和 SHA-256。
- 增加可配置的最大 artifact 大小。
- 超限返回 413。
- 读取前后检查文件 size，必要时检测文件变化。
- 保持返回的 sha256、size 和 verification 信息一致。

#### 测试

- 超过限制返回 413。
- 大文件不调用全量 `readFile`。
- 文件在发布过程中增长时不会发布错误 hash/size。
- 正常小文件的版本和 hash 保持兼容。

### BUG-006：Node artifact/provenance 版本号并发冲突

证据：`apps/server/src/artifact-routes.ts:17-23,29`、`apps/server/src/persistence.ts:9-12`。

版本计算采用“读取全部记录 → 计算最大版本 → append”，并发请求可能得到相同版本。`appendJsonLine` 没有业务级锁。

#### 修复要求

- 为 workspace metadata 写入增加串行队列或锁。
- 读取、版本计算和追加必须处于同一临界区。
- artifact 和 provenance 都要覆盖。
- 保证失败请求不会留下半条 JSON 或错误版本。

#### 测试

- `Promise.all` 并发记录同一路径，版本必须唯一且连续。
- 并发发布同一个 artifact，不能产生重复版本。
- 模拟一次 append 失败后，后续写入仍可恢复。
- 既有 torn-tail 容错行为不能被破坏。

### BUG-007：claim-check 接受 NaN 和非法范围

证据：`apps/server/src/artifact-routes.ts:32`。

`Number("abc")` 得到 `NaN`，当前比较逻辑可能将无效 minimum/maximum 当作没有约束；同时没有检查 minimum 是否大于 maximum。

#### 修复要求

- 对 minimum、maximum 使用有限数校验。
- 拒绝 NaN、Infinity 和无法解析的字符串。
- 拒绝 `minimum > maximum`。
- 对 direction 的非法值返回 422，而不是静默忽略。

#### 测试

- 非数字 minimum/maximum 返回 422。
- Infinity、NaN 和空字符串按非法输入处理。
- minimum 大于 maximum 返回 422。
- 合法数字字符串和现有 positive/negative 行为保持不变。

## 额外安全检查

修复完成后，另行检查以下边界，不必扩大为无关重构：

- `resolveWorkspaceFile` 的 symlink race 和 containment 测试。
- Node 与 Python workspace security 行为是否一致。
- 所有使用 `request.params` 拼接文件路径的路由。
- 所有对用户提供 URL 发起网络请求的接口。
- artifact verify、provenance record 和 project state 的并发写入。

## 验收命令

```bash
pnpm test
pnpm typecheck
pnpm build
uv run pytest
```

如果 Python 测试因环境权限失败，先记录失败原因，再用项目批准的 Python/uv 环境重新运行；不能把“测试未执行”报告为“测试通过”。

## 最终交付格式

另一个模型完成后，必须返回：

1. 修复的 bug 编号及简短原因。
2. 修改文件列表。
3. 每个 bug 对应的测试文件和测试名称。
4. 完整测试命令及最终通过/失败数量。
5. 是否存在兼容性变化。
6. 尚未解决的风险或需要人工确认的策略选择。
