# PR #104：会话「等 45 秒后超时」的原因与修复

状态：已修复，本地提交 `ecd21a7a`（分支 `pr-104`，未 push）
实测环境：隔离实例，模型 `opencode-go/deepseek-v4.1-flash`

## 一句话

发消息时，如果这个会话的 Pi Orbit runtime 不在运行，服务端会把「给该工作区首次创建隔离环境（micromamba）」这件几十秒的重活算进这次 `/prompt` 请求里。浏览器给普通请求的预算是 45 秒，于是先报超时；其实后端还在继续，这一轮最后会自己跑完。

## 现象

- 新建会话发第一条消息：正常。
- 同一会话发第二条：转圈约 45 秒 → 出现红色报错 `Request timed out while contacting the Pi-Science backend`；再过几十秒，回答又自己出现了。
- 应用重启后，在以前的成功会话里追问：同样超时。

## 原因

1. 前端：`POST /api/sessions/:id/prompt` 用的是默认 45 秒预算（`frontend/src/lib/client/http.ts` 的 `REQUEST_TIMEOUT_MS`）；而建会话 `POST /api/sessions` 用的是 180 秒（`RUNTIME_START_TIMEOUT_MS`）。
2. 服务端：`apps/server/src/runtime/node/node-session-service.ts` 处理 `prompt` 时先 `activateUnlocked()`；该会话没有活着的 runtime，就要 `startRuntime()`。
3. `startRuntime()` 第一步是 `environments.environment(cwd)` → `provision()`。PR #104 要求 runtime 启动前必须有隔离环境，而首次要**新建一个 micromamba 环境**（conda-forge 求解 + 下载 + 链接），在 `apps/server/src/runtime/workspace/workspace-environment.ts` 的 `createRevision()` 里执行 `micromamba create`，实测 36–44 秒。
4. 探针实测：`/prompt` 的 ack 是 37.5s / 43–46s，其中 `start-runtime:workspace-environment` 就占 36–44s，唯一大头是 `create-revision:micromamba-create`（36,141ms / 43,662ms）；其余阶段都是毫秒级。

所以「首轮成功」是因为它走 180 秒预算的建会话，「第二轮 / 追问超时」是因为它走 45 秒预算的 prompt。这个 provision 每个工作区只需一次，做完后 prompt 只要 10–30ms，所以之后就快了。

不是事件流或模型慢：SSE 的 `agent_start` 在 ack 返回后立刻到达，卡住的时间全在 ack 之前。

## 附带发现（同一 PR 的沙箱路径）

会话里的 Bash 由沙箱扩展回调控制面执行，但扩展用**硬编码默认端口 8787**，且只从 runtime 环境里读 token。所以非默认端口或服务端自生成 token 时必然 401：实测 bash 工具返回 `control-plane authentication required`，而不是命令输出。

## 修复（`ecd21a7a`）

1. **前端**：`sendPrompt` 改用 180 秒（runtime 启动预算），不再中途放弃后端仍在执行的这一轮。
2. **服务端**：打开工作区（会话列表请求）时**后台预热**环境——串行执行、按工作区去重、失败后 5 分钟冷却。prompt 要么直接命中已就绪环境，要么汇入正在进行的 provision。
3. **沙箱**：启动时把控制面真实 origin 与 token 写进 runtime 继承的环境，扩展回调不再猜端口、不再缺凭证。
4. **探针**：`PI_SCIENCE_PROBE_LOG=1` 时打印 turn 各阶段耗时、事件流帧与静默间隔、provisioning 各阶段耗时；默认关闭，不影响正常运行。

## 验证

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 打开工作区、停顿后再追问 | 37,273ms | **930ms**（停顿 60 秒时 **27ms**） |
| 打开工作区、立刻追问（首次 provision 无法避免） | 46,697ms → 浏览器报超时 | 41,841ms → 正常受理，不报错 |
| 新会话第一轮 / 第二轮 | 19ms / 21ms | 20ms / 19ms |
| 沙箱 bash（`echo sandbox-ok`） | `control-plane authentication required` | `sandbox-ok` |

单元测试：前端 986 通过；服务端 888 通过、20 跳过，另有 1 个失败 `app.test.ts > becomes unready if the SQLite worker exits after startup`——该失败在**未改动的提交上同样出现**，属既有问题。新增的前端测试用假时钟证明「50 秒才返回的 ack 不再被中断」，这条测试在未修复的提交上会失败。

## 怎么复现

```bash
bash /tmp/pi-probe/ui-stack.sh status                        # 看 ready-revisions=0（未 provision 才复现得出）
bash /tmp/pi-probe/ui-stack.sh trigger baseline              # 未修复：期望 ack > 45s，判为超时
bash /tmp/pi-probe/ui-stack.sh trigger fixed 60000           # 已修复：停顿 60s 再发，期望立即受理
PI_STACK_HIDE_MICROMAMBA=1 bash /tmp/pi-probe/ui-stack.sh reset baseline|fixed   # 变回未 provision，便于重测
```

判据就是 ack 耗时与 45,000ms 这条线的关系。UI 上对应两套临时栈：未修复 http://127.0.0.1:5281 、已修复 http://127.0.0.1:5273（`/tmp` 下的测试栈与脚本不属仓库内容）。
