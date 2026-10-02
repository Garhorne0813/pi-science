# Agent-core 能力与验收范围

PR #115 的 agent-core 路径保留显式开关。默认仍使用 Orbit，不移除既有运行时。

| 能力 | agent-core 实现 | 验证/范围 |
| --- | --- | --- |
| read/bash/edit/write | Harness 原生工具 | 快速写文件产物、崩溃恢复；bash 使用工具环境白名单 |
| 模型、思考档、上下文、压缩 | canonical 路由与 Harness | 本地流式模型验证路由、别名、凭据隔离及 live/cold state |
| todo | MIT 授权的 rpiv-todo 纯领域逻辑 + Harness 工具 | action/schema/状态机与原 2.4.0 一致；分支历史恢复、并发、重放、完整 details |
| 对话 subagent | 父 Worker IPC → 服务端管理的隐藏 v4 Worker | single、最多 8 步 chain、最多 4 个 parallel；子会话关联和结果缓存持久化；取消、10 分钟期限、2 MB 响应上限 |
| 子代理定义 | `.pi/agents/<name>.md` + planner/delegate/reviewer 内置角色 | frontmatter 的 tools 可收窄父工具范围；继承父模型与资源策略；深度上限 2 |
| research runner | `CoreResearchSubagentRunner` | 复用原结构化校验、修复、状态/费用、停止接口；Node/JobCoordinator 仍管理串行研究循环 |
| review runner | `CoreReviewSubagentRunner` | 复用原 5 分钟期限、一次 JSON 修复与结果校验；工具禁用 |
| 子 Worker 资源 | `AgentRuntimeManager` | 普通会话、子代理、研究、复查共享进程级容量；`PI_SCIENCE_AGENT_MAX_WORKERS` 默认 16；跨 manager 排他归属 |
| 技能/模板/命令 | 上游 loader 与 invocation formatter | `.pi/skills`、配置技能目录及 `.pi/prompts`；策略控制菜单与执行；refresh 更新资源；前端展示模板 |
| Notebook | 现有 Notebook 扩展 API 的 Harness 适配 | 保留现有工具与内部服务鉴权 |
| Questionnaire | 现有验证/格式化 + Worker InteractionBridge | 浏览器请求、响应、取消仍由会话 Worker 拥有 |
| Managed MCP | 官方 SDK + 现有 connector 投影 | stdio/HTTP/SSE/socket、允许工具列表、确认和每 connector 凭据；现有测试覆盖 |
| Web access | 通过配置的 managed MCP 工具提供 | agent-core 不装载 Orbit 的 `pi-web-access` 扩展，也不自动读取/迁移该扩展的独立搜索配置；媒体提取、浏览器 cookie、curator UI 尚无等价适配 |
| subagent 扩展额外模式 | 本轮不提供 | async、workflow、missions/schedules 以及其他执行后端不在现有迁移合同内；不对模型宣称这些能力 |
| 子代理交互工具 | 本轮不提供 | 隐藏子会话不开放 questionnaire/MCP 确认，避免向不可见会话发送浏览器问题；由父会话处理交互 |
| v3 迁移 | 复制、完整校验、登记归属、启动 | 独立 `PI_SCIENCE_AGENT_CORE_MIGRATE_LEGACY=1` 开关；未开启时既有 v3 会话继续走 Orbit；原文件保留 |
| v4 兼容 | 0.87.1 → 0.99.2 | 实际旧 API 生成的 admission fixture；新格式降级读取尚未验收 |
| context-mode | 继续默认关闭 | 仍需独立适配，不属于核心压缩实现 |
| 图片 prompt | 本轮不提供新入口 | 后续另做端到端验收 |
| OS sandbox | 暂缓 | 不满足新会话默认切换及 Orbit 退役的发布条件 |

Todo 采用 `@juicesharp/rpiv-todo` 2.12.0 的纯领域模块，保留 MIT 声明；与原安装版本 2.4.0 的 reducer、参数 schema 和状态转换对照仅有注释差异。未引入 coding-agent/TUI 运行时依赖。

以上验证基于 Linux 和受控本地模型。真实用户的复杂 v3 文件、真实研究服务调用、Windows 启动及依赖降级兼容仍是发布验收项，合成 fixture 不代替这些证据。
