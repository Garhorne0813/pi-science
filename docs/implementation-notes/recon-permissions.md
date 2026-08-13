## 核心结论摘要

**背景澄清**：仓库中**不存在**根级别 `runtime/pi/`（CLAUDE.md 描述为 "fetched"）。实际 Pi agent 代码全在 `apps/server/src/runtime/pi/`，fetched CLI 由 `PI_CLI_PATH` 定位（`pi-runtime-launch.ts:48`），因此角色隔离只能依赖 **Node 控制面 + Pi runtime 接口**，无法改 fetched CLI 源码。

**现有安全模型**（全部是 Node 侧强制）：
- 文件：`workspace-security.ts` 的 `validateWorkspaceCwd`/`resolveWorkspaceFile`（含 symlink realpath 防逃逸、`.pi-science` 元数据禁止）
- 网络：`outbound-security.ts` SSRF 防护（私网段阻断、DNS 重绑定、逐跳重校验）、`egress-audit.ts` 审计
- Pi 进程级：`buildPiProcessOptions` 注入 `PI_WORKSPACE_DIR` + `--approve`/`--no-extensions` + `workspaceSkillPolicy`（**当前唯一能力开关**，仅技能 allow/deny）+ Orbit host 的 `workspaceBinding`/`projectTrustApi` runtime 绑定

**关键差距（直击 4.4）**：**"由 Node/Pi runtime 强制而非只写在 prompt" 完全缺失。**
- Reviewer（`project-review/service.ts` + `subagent-runner.ts`）只读**仅靠 prompt**："Do not edit files, do not run code, and do not use tools"，其 throwaway runtime 仍有完整 bash/prompt 命令面（`pi-process.ts sendCommand` 无按角色裁剪）
- 角色 DTO 已存在但**未接线**：`catalog-routes.ts:413-417` 的 `RESULT_REVIEWER`（read_scope/write_scope）、`BOOKMARKER` —— 无 contracts schema、无前端消费、无运行时强制
- Bookmarker 是**关键词启发式** + `proposed`/`agent_proposal` 状态（`conversation-navigation-routes.ts:37-50`），绝非"只选 span"的逼真实现
- **Memory Ledger 已基本满足 "Memory proposer 只提交候选"**（`ledger.ts` 全状态机 + `project-routes.ts` accept 由 HTTP/用户触发），缺口在 `ApprovalRequirement="policy"` 判定与 `accepted→superseded` 流转
- Executor/Compute worker 的"声明 IO"在 `research-loop/candidate-snapshot.ts` 已有雏形（快照 chmod 只读 + `PI_SCIENCE_OUTPUT_DIR`）

**实现建议**：优先在 **Pi runtime 启动参数**（复用已证明可行的 skillPolicy→`PiOrbitRuntimeRequest` 链路）落实 per-role capability；若 fetched CLI 不支持只读开关，则落在 **`PiProcess.sendCommand` Node 拦截层**（按 runtime 角色过滤命令面）；Executor 显式声明 inputs/outputs + 授权门；打通 policy 审批与 superseded。报告已含完整风险点（fetched CLI 能力未知、默认放行陷阱、subagent 继承工具绕过）与测试
