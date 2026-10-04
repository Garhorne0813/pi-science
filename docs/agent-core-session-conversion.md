# Agent Core 会话转换

Pi Science 只使用 Agent Core；Orbit 可执行文件、Host、RPC/Web 传输、runner 和下载安装脚本已删除。`PI_CLI_PATH`、`PI_ORBIT_*`、`PI_SCIENCE_AGENT_RUNTIME` 和 `PI_SCIENCE_AGENT_CORE_MIGRATE_LEGACY` 不再决定运行时。安装和启动方式不变。

## 离线批量转换

停止 Pi Science，在项目根目录执行（命令会取得同一实例锁，避免与运行中的服务同时写入）：

```bash
pnpm migrate:sessions --dry-run /absolute/path/to/workspace
pnpm migrate:sessions /absolute/path/to/workspace
# 一次处理多个工作区；与应用使用相同的 PI_SCIENCE_HOME
pnpm migrate:sessions /path/to/workspace-a /path/to/workspace-b
```

命令递归读取工作区元数据根目录下的 `sessions/**/*.jsonl`。已注册项目使用 relocated metadata root；未注册的旧项目使用 `.pi-science`。输入必须是该工作区的 v3 会话；工作区路径别名按文件系统实际路径匹配。

- 不需要大模型 API、key、Python 环境或网络连接；不启动 Worker。
- 校验完整 JSONL、重复 ID 和父子关系，保留原始文件，不原地覆盖。
- 副本写入 `agent-sessions`，使用官方 `JsonlSessionRepo` 写入迁移标记，原子升级为真正的 v4 存储。
- 保留会话 ID、消息顺序、工具结果/details 和 SDK 支持的模型/思考、分支及压缩记录。Core 会重新生成消息条目 ID；`entryIds` 输出并持久保存旧消息 ID → 新消息 ID 映射。
- 已转换会话返回 `already-converted`；已删除会话返回 `deleted`，不会从保留的原文件复活。
- 单文件失败返回 `failed`，继续处理其余文件；任何失败使进程退出码为 1，用法错误为 2。`--dry-run` 只预检 JSONL、ID 和父子关系，不写会话；正式转换还会进行 SDK 格式校验。
- 导入后的旧后台标题/子代理会话保持隐藏，避免混入正常对话列表。

正常使用旧会话时也会自动执行同一转换；历史和索引请求等待转换完成，首次打开不需要刷新。转换成功后继续对话仍需配置有效模型与凭据；转换操作本身不需要这些信息。重放的浏览器消息缓存或旧消息书签应重新载入历史，或按 `entryIds` 更新。

## 明确退役的旧能力

不再加载任意 Orbit 扩展。Notebook、问卷、todo、对话 subagent、托管 MCP、研究/复查和标题生成使用 Core 或共用领域逻辑。Web 搜索/URL 抓取通过托管 MCP 提供；旧 `pi-web-access` 的媒体提取、浏览器 cookie、curator UI，以及 context-mode、旧子代理 async/workflow/mission 模式不保留兼容入口。OS 级 sandbox 仍未实施，工具继续使用现有工作区和凭据隔离规则。

## 运行监督和工具能力

会话 watchdog 默认每 60 秒检查 Worker。除 IPC 失败、运行故障和事件丢失外，当前 operation 连续 15 分钟没有模型、工具、压缩或重试进展，也会触发强制终止并从持久检查点恢复；成功读取状态不算进展。`PI_SCIENCE_OPERATION_NO_PROGRESS_MS` 可调整无进展期限，长时间静默的合法工具应设置更长期限；等待用户问卷或权限确认的时间不计入。`PI_SCIENCE_EVENT_WATCHDOG_MS` 控制检查间隔，非正值会关闭 watchdog。连续恢复最多三次，再次卡住会停止 Worker、报告终止自动恢复的错误，并保留检查点供显式重新打开会话重试。

Worker 的 `allowedTools` 是精确工具能力列表。显式空列表或仅包含 `read`、`subagent` 等非 MCP 工具时，跳过整个 MCP discovery，不启动 connector、不建立连接，也不读取 connector 凭据。未限制工具或明确允许 `mcp__...` 工具时才初始化 MCP；发现后仍按完整工具名过滤。
