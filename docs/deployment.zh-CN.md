# 安装与本地生产部署

[English](deployment.md) · [README](../README.zh-CN.md)

源码安装流程会构建 contracts、Node 控制面、Agent Worker、SQLite 资源、内核桥接脚本和 React 前端。生产模式在 `http://127.0.0.1:8787` 同时提供浏览器页面和 API。需要包含 npm 的 Node.js >=24.16.0；npm 将 package.json 中 `packageManager` 声明的精确 pnpm 版本引导到缓存中。安装期间需要访问包注册表，启动期间不下载软件包。

| 操作 | macOS / Linux | 原生 Windows |
| --- | --- | --- |
| 安装并构建 | `bash scripts/install.sh` | `powershell -File scripts/install.ps1` |
| 环境诊断 | `bash scripts/pi-science.sh doctor` | `powershell -File scripts/pi-science.ps1 doctor` |
| 生产模式启动 | `bash scripts/start.sh` | `powershell -File scripts/start.ps1` |
| 开发模式启动 | `bash scripts/start.sh --dev` | `powershell -File scripts/start.ps1 -Dev` |
| 停止后台或已验证归属的服务 | `pi-science stop` | `pi-science stop` |

`pi-science` 安装到用户的可执行文件目录。Bash 还支持 `start --detach --no-open`，PowerShell 保持前台运行。两者均支持 `status`、`logs`、`install` 和 `doctor`。日志位于仓库内的 `.runtime/pi-science`，应用数据和工作区目录继续使用原有配置。

`PI_SCIENCE_FRONTEND_DIST` 接受绝对路径，或相对于仓库根目录的路径，不受启动器或 `doctor` 调用目录的影响。启动器先将其规范化为绝对路径，再检查构建并传入子进程。

Windows 的 `logs` 默认按文件展示控制面和前端的 stdout/stderr，并标明文件名；`logs --stderr` 仅展示错误输出，`logs --all` 显式展示全部输出。不同日志文件的内容不会按时间戳交错排序。Windows 前台启动也将服务输出写入这些文件。POSIX 前台输出保留在终端，`logs` 读取 `start --detach` 写入的文件，可能来自上一次后台运行。

`doctor` 的必需检查失败时退出码为 1，参数无效时为 2。它不安装软件、不初始化持久数据库、不联系 LLM，也不测试网络下载是否可用。对于尚不存在的数据目录，它检查最近的现有父目录，不创建目录。科学计算环境和提供商配置作为按需设置单独说明。请在启动前运行诊断：即使端口由另一个 Pi-Science 实例占用，也会报告端口冲突。

POSIX 的就绪检测和状态检查使用已必需的 Node.js，启动应用不再依赖 `curl`。每次 HTTP 请求最多耗时 2 秒，覆盖连接、响应头和响应体，并受共享启动截止时间的剩余时长约束。超过截止时间后直接清理已启动的自有服务，不再额外探测。

## 故障恢复

- 缺少构建或依赖：重新运行对应平台安装器。修改源码后需要刷新生产构建；编辑源码时可使用 `start --dev`。
- 端口被占用：查看 `status`，停止已确认归属的应用，或修改 `PI_SCIENCE_CONTROL_PLANE_PORT`。停止命令不会仅凭端口号结束未知进程。
- Windows 停止操作在内部区分 `stopped`、`already_exited`、`unverified` 和 `failed`。停止不完整时返回退出码 1，并保留完整身份记录以便重试，包括 CIM 查询失败、结束进程失败或等待退出超时的情况。只有两个服务均确认退出，或记录的身份确认过期时，才删除状态文件。子进程停止失败时保留父进程，使重试仍可追踪归属。每条父子关系都要求子进程创建时间不早于父进程，避免父 PID 复用把无关的旧进程及其后代纳入清理。快照根进程必须与已验证身份匹配，终止后代前还会复查祖先创建时间；祖先身份变化时停止操作失败并保留记录。端口诊断优先使用记录的部署模式和端口，否则使用当前模式；生产模式只检查控制面端口。没有记录但相关端口被占用时，仅报告归属未知的监听进程，不认定为本项目服务。
- Windows 状态文件缺失或过期：手动核对进程，不应根据监听端口猜测归属。缺少身份信息的旧状态文件不会被用于停止进程。
- 崩溃或 Windows 强制停止后，现有应用实例锁有 30 秒的恢复宽限期。`doctor` 会报告仍在运行或近期创建的实例锁，请等待宽限期结束后再启动。
- 启动错误：查看 `pi-science logs` 和 Windows 的 `*.log.err` 文件。启动失败时会清理已确认归属的进程；内部随机令牌生成失败时会拒绝启动。
- 数据迁移错误：保留原始数据，使用兼容的应用版本恢复完整备份。Git 源码降级不能代替数据回滚。

启动器绑定到回环地址。前端内部 HttpOnly Cookie 不构成独立的用户身份或授权体系；远程多人部署需要另行设计身份认证和授权边界。

## 验收与后续工作

`node --test scripts/doctor.test.mjs scripts/check-http-health.test.mjs` 覆盖诊断失败和 HTTP 请求截止时间，包括响应头无响应和持续传输响应体。`bash scripts/test-launcher.sh` 在 `curl` 不可用时覆盖源码模式的启动、停止和进程身份校验，并验证前台和后台启动的 HTTP 挂起超时及清理。`powershell -File scripts/test-process-identity.ps1` 覆盖身份缺失或过期、仓库/入口/令牌不匹配以及有效归属；其中的 CIM 模拟可跨平台运行。

`node scripts/smoke-production.mjs` 使用实际构建产物和对应平台启动器，检查 SQLite 就绪状态、HTML、JS 资源、SPA 路由回退、认证 API、状态记录和查询、停止清理，以及对外部监听进程的保护。CI 生产安装任务在 Linux、macOS 和 Windows 上运行实际安装器，不预先执行 pnpm 安装步骤。上述验收不需要 API Key 或 Python/R 环境。

后续工作包括版本化 Release、独立安装包、在停止应用后备份数据并支持恢复的事务式更新器，以及默认保留用户数据的卸载功能。当前改动尚未实现这些命令。备份必须包含应用状态和工作区内的元数据，详见[数据归属](architecture.zh-CN.md#持久化与数据归属)。
