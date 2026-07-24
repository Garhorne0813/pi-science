# Bug 修复执行提示词

你是这个仓库的高级工程师。请在当前工作区执行 `docs/bug-review-remediation-plan.md` 中的修复任务。

## 总体要求

对以下问题进行真实代码修复，并补充回归测试：

1. 自定义模型发现 SSRF
2. `/api/settings/subagents` 绕过 workspace 校验
3. `job_id` 路径穿越
4. Job 取消状态被后台任务覆盖
5. Node artifact 发布无大小限制且一次性读入内存
6. Node artifact/provenance 并发版本冲突
7. `claim-check` 接受 NaN 和非法范围

不要只给建议，必须修改代码和测试。不要进行无关重构。

## 开始前

1. 查看 `git status`，保留已有用户修改，不要 reset、checkout 或删除无关文件。
2. 仓库存在 `.codegraph/` 时，优先使用 CodeGraph：

```bash
codegraph explore "<问题或符号>"
codegraph node "<符号>"
```

3. 阅读相关实现和现有测试，确认实际调用路径后再修改。
4. 先写失败测试，再实现修复。

## 修复要求

### A. SSRF

检查 `apps/server/src/settings-routes.ts` 的 custom provider discover。

- 拒绝 localhost、loopback、私网、链路本地、保留地址、IPv4-mapped IPv6。
- DNS 解析后校验实际 IP，不能只检查字符串。
- 禁止重定向，或对每次重定向重新校验。
- 保留超时和响应大小限制。
- 优先复用现有 egress policy/gateway。
- 不得泄露 API key。

至少测试：`127.0.0.1`、`localhost`、`169.254.169.254`、私网地址、DNS 解析到私网、重定向到私网、公网正常 URL、超时和大响应。

### B. Workspace 校验

检查 `/api/settings/subagents`。

- 必须调用 `validateWorkspaceCwd`。
- 只允许注册 workspace。
- 响应不要暴露主机绝对路径。
- 测试未注册路径、`..`、绝对系统路径、symlink escape 和合法 workspace。

### C. Job ID 与取消

检查 `apps/server/src/job-routes.ts`。

- `job_id` 只能接受服务端生成格式，例如 `job_` 加 16 位字母数字。
- `jobPath` 必须做格式和 containment 校验。
- GET、DELETE、logs 都必须使用同一安全校验。
- 修复取消与后台收尾的竞态：取消后最终状态必须保持 `cancelled`。
- 取消操作必须幂等，并正确终止子进程。

测试路径穿越、pending 取消、running 取消、重复取消、晚到 close 事件和 timeout。

### D. Artifact 与 Provenance

检查 `apps/server/src/artifact-routes.ts` 和 `persistence.ts`。

- artifact 发布改为流式 hash，增加最大大小限制，超限返回 413。
- 读取前后检查文件变化。
- artifact/provenance 的读取、版本计算、追加必须串行化。
- 并发请求不能产生重复版本或丢失记录。

使用并发测试，例如 `Promise.all` 同时发布/记录同一路径，验证版本唯一且连续。

### E. Claim Check

检查 `/api/artifacts/claim-check`。

- 拒绝 NaN、Infinity、非法数字字符串和空值。
- 拒绝 `minimum > maximum`。
- 非法 direction 返回 422，而不是静默忽略。
- 保持合法输入的现有行为。

## 验证要求

修改后依次运行：

```bash
pnpm test
pnpm typecheck
pnpm build
uv run pytest
```

如果测试失败，继续定位并修复；不要隐藏失败、跳过测试或降低断言强度。若环境问题导致 Python 测试无法运行，明确说明原因和未验证范围。

## 最终回复格式

最终只需汇报以下内容：

1. 已修复的 bug 编号。
2. 修改文件列表。
3. 每个修复对应的测试文件和测试名称。
4. 完整测试命令及结果。
5. 兼容性变化。
6. 未解决风险。

所有结论必须基于实际代码和测试输出，不要声称未运行的测试已经通过。
