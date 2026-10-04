# Agent-core 能力与验收范围

Pi Science 使用 Agent Core SDK 和独立 Worker 执行对话、研究、复查与标题生成。旧会话可自动转换或离线批量转换，参见[转换说明](agent-core-session-conversion.md)。

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
| Web access | 通过配置的 managed MCP 工具提供 | Web 工具由 MCP connector 配置管理；媒体提取、浏览器 cookie 和 curator UI 不在当前能力范围内 |
| subagent 扩展额外模式 | 本轮不提供 | async、workflow、missions/schedules 以及其他执行后端不在现有迁移合同内；不对模型宣称这些能力 |
| 子代理交互工具 | 本轮不提供 | 隐藏子会话不开放 questionnaire/MCP 确认，避免向不可见会话发送浏览器问题；由父会话处理交互 |
| v3 迁移 | 复制、完整校验、SDK 原子升级、登记归属 | 首次使用自动转换；`pnpm migrate:sessions` 提供无 Worker、无模型调用的批量转换；原文件保留并记录消息 ID 映射 |
| v4 兼容 | 0.87.1 → 0.99.2 | 实际旧 API 生成的 admission fixture；新格式降级读取尚未验收 |
| context-mode | 未提供 | 仍需独立适配，不属于核心压缩实现 |
| 图片 prompt | 本轮不提供新入口 | 后续另做端到端验收 |
| OS sandbox | 暂缓 | 当前无 OS 级隔离保证 |

Todo 采用 `@juicesharp/rpiv-todo` 2.12.0 的纯领域模块，保留 MIT 声明；与原安装版本 2.4.0 的 reducer、参数 schema 和状态转换对照仅有注释差异。未引入 coding-agent/TUI 运行时依赖。

以上验证基于 Linux 和受控本地模型。真实用户的复杂 v3 文件、Windows 全功能界面验收及依赖降级兼容仍需额外验证，合成 fixture 不代替这些证据。
