# PR #115 实施记录

> 更新：当前已移除 Orbit 运行时，统一使用 Agent Core；以下阶段性记录中的 opt-in/兼容计划属于历史状态。现行会话处理见[转换说明](agent-core-session-conversion.md)。

按 [优化方案](prd-agent-core-runtime-optimization.md) 分阶段实施。Sandbox 暂缓，默认运行时仍为 Orbit，agent-core 保持显式开关。

## 已完成

1. `8d01df6`：锁定 `pi-agent-core` / `pi-ai` 到 `0.99.2`。新增由实际 `0.87.1` API 生成的 v4 admission fixture，验证恢复、请求去重及 fork。现有 agent-core 回归、服务端类型检查和构建通过。
2. `08fed6b`：canonical 模型资源、endpoint 路由、受管凭据和能力进入 Harness；按上游能力计算思考档。接通实际上下文用量、模型绑定的窗口覆盖、自动压缩设置及压缩事件。模型调用使用本地流式服务，验证两个 endpoint 的凭据隔离与模型别名，以及 live/cold state、手动压缩。全项目类型检查、服务端构建、52 项相关测试通过。
3. `aa4468c`，Turn 生命周期：提取共享产物处理；prompt 发送前持久化基线；恢复和重放去重；自动复查按 session/turn 留存去重记录；复用现有统计与时间投影。新增真实子进程测试覆盖快速写文件、杀 Worker 后主动恢复，以及丢失 settled 事件后的生命周期补完。相关 135 项测试与服务端类型检查、构建通过。
4. Todo：沿用 `rpiv-todo` 的 action、状态机与完整快照契约；v4 历史及实时事件投影保留 details。状态与 invocation receipt 原子提交，恢复按分支历史读取，验证并发、重放、重开和旧分支。
5. Subagent：新增 IPC 委派和持久化隐藏会话，支持 single/chain/parallel；分别接入 core research/review runner，保留各自生命周期与 Node 串行研究权威。所有 manager 共享 Worker 容量与排他会话归属。
6. 命令与迁移：技能/模板使用上游 loader/formatter，菜单遵守策略；v3 导入使用独立开关，完整副本验证在登记前完成。测试覆盖损坏文件拒绝、compaction/分支及工具快照保留。详细边界见 [能力清单](agent-core-capability-inventory.md)。

## 最终验证

2026-10-02：

- `pnpm typecheck`：contracts/server/frontend 通过。
- 服务端与前端生产构建通过。
- 服务端全量：934 通过、15 跳过，108 文件通过、1 文件跳过。命令：`pnpm --filter @pi-science/server exec vitest run --maxWorkers=1 --testTimeout=20000`。原提交已有的 MCP DNS 测试在默认 5 秒下超时，已单独复现。
- 前端全量：1,227 通过；contracts：13 通过；skills：28 通过。
- 回归中发现关闭流程未等待事件 observer 的统计/产物写入；修复 Hub drain 和 observer 的异步持久化，新增关闭等待用例。父任务取消子 Worker 的实际进程测试也通过。
- 不合并 PR，不切换默认运行时。

## 尚未完成的发布验收

- 本轮执行环境为 Linux，尚未进行 Windows 实机启动验证。
- v4 fixture 证明旧版本文件可被新版本恢复；尚未证明所有新写入格式可由 `0.87.1` 读取，不能把降低依赖版本当作已验证回退方式。
- 测试模型为受控本地服务；真实研究会话与真实用户 v3 样本的验证需单独记录，不以合成数据代替该结论。
- Sandbox 和默认运行时切换不在本轮实施范围。
