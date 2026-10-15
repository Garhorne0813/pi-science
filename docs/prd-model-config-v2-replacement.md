# 模型配置 PRD v2：Pi-native 完全替换

状态：执行方案。2026-10-15，取代 PRD v1.1 中 legacy 默认、shadow、LegacyRouteAdapter 与延后切换的条款。范围为 PR #155；其余安全、会话与持久化约束继续有效。

## 1. 目标与非目标

models.json + CredentialStore + Pi 0.99.2 registry 成为唯一模型配置权威。Settings、Catalog、模型选择、所有 Worker 启动均从此来源构建；没有旧资源图回退，也不因错误、空目录或未配置凭证而切回旧实现。旧配置不自动启用、不自动迁移。

不升级 pi-ai/pi-agent-core，不引入 pi-coding-agent，不修改 SSE v3、ProductInput、Worker IPC、Durable Session、Worker 环境白名单或 MCP/Job/Notebook 隔离。不实现多 Endpoint 调度或任意认证 Header。

## 2. 唯一来源与首次启动

- 唯一 backend 为 pi_ai_v1，默认即启用；旧 legacy/shadow 值明确拒绝，不能重新打开旧路径。
- 保留现有 schema_version: 1 的原生配置格式，但 legacy_providers 只能为空；含旧适配条目的文件 fail closed，要求显式整理配置。不存在 models.json 时返回纯空配置，不扫描旧配置、不写盘，内置目录仍可展示但不自动采用环境密钥。
- 运行时移除 legacyAgentModels 和旧资源图认证/别名/可用性回退。格式损坏时可展示配置错误并修复文件，绝不静默使用旧数据。
- 旧 model-resources.json/config.json 的模型配置只供显式导入工具读取。历史文件保留为备份；不能删除仍被 MCP 或其他资源引用的 Credential。
- Settings 页面始终使用新编辑器，加载失败显示错误，不能显示旧编辑器。保留 provider-views 等现有 DTO 以服务模型选择，但全部由新 registry 投影。

## 3. 旧入口退出

完整 App 对旧 Provider/Model/Endpoint/Binding/Credential CRUD 和旧 Settings API Key/custom-provider 入口所有方法返回 410 model_config_retired，并指向新 API；请求在验证/发现/网络访问和写盘前终止。旧 CRUD 不再在 App 注册为有效资源操作。

/api/provider-views、/api/settings/config、/api/settings/providers 与模型选择接口继续提供当前前端所需的读取形状，只从新配置构造。新配置中的显式别名在 Settings、模型选择、普通会话及 research/review/title Worker 启动中采用同一解析规则；只投影，不改写保存的默认值。Default Model 与已有 Session Model 的所有权继续独立；旧默认模型不自动替换，不可用时明确显示 unavailable_model。

## 4. 显式一次性导入

GET /api/model-config/migration 只读报告；POST 必须提交 native revision、源 fingerprint 和显式 excluded_provider_ids。导入是可选管理工具，不是启动或推理依赖；可随时直接在新设置中重建。

- 可证明等价的简单资源标为 migrated；新系统已经配置的 ID 标为 existing，不覆盖。
- 无法证明等价的条目标为 blocked，并列出原因；不写入 legacy_providers，不创建旧路由。
- 转换结果必须先通过目标 Provider ID 与完整 ProviderConfig Schema；不兼容 URL（包括 query/hash/userinfo）、重复模型及其他格式差异在 plan 阶段报告 native_schema_incompatible，不得等到 apply 拖累健康资源。
- 共享 Endpoint、跨 Provider/MCP Credential、空自定义目录、native Gateway、内置 Provider 的显式 Endpoint/不明确协议、多 Binding/priority/policy、禁用/OAuth/不支持能力均阻断自动转换。
- 默认 apply 在存在 blocked 条目时拒绝；只有 excluded_provider_ids 与报告阻断项完全匹配时才允许导入健康子集，避免静默丢弃。排除项在新系统中不可用，须手工重建。
- 只导入目标存在的新模型别名；不导入指向被排除资源的别名。备份、source fingerprint、revision、锁、完整结构校验与原子提交继续执行。旧资源与凭证所有权不变。

## 5. 安全与一致性

认证值只保存在 CredentialStore；显式 EnvRef、托管密钥、Keyless 均通过新配置映射。轮换采用 copy-on-write，不删除共享凭证。Provider/Model/Override Header 只允许已定义协议格式的 Accept、Content-Type、Anthropic-Version、Anthropic-Beta。拒绝任意认证 Header、CRLF、重复大小写名称以及未知格式。

每次写入执行完整结构与语义校验；仅新增/改变 URL 执行网络 preflight；运行时始终保留出站 DNS/私网/重定向防护。已有 DNS 故障不得阻止其他 Provider 凭证轮换。

## 6. 验收与发布

必须证明：无配置且有旧密钥/资源时，新目录/Settings/Worker 不采用旧配置；新的 managed/EnvRef/Keyless 在各视图与真实 Worker 一致且脱敏；仅 credential_refs 的旧 builtin 共用密钥不进入运行时；旧入口所有方法均不能读出旧权威或写盘/发网络请求；旧 backend 与非空 legacy_providers 明确拒绝；混合导入必须显式排除阻断项且不改变旧文件；损坏文件不回退；revision、原子写、SSRF 与 Session/default 独立性回归继续通过。

执行 pnpm test、pnpm typecheck、pnpm build、frontend test:bundle、frontend test:uat:model-config、pnpm smoke。真实厂商、生产网络/CA、存量数据导入演练与生产发布需要独立验收；本任务不执行生产迁移或自动合并。

回滚通过部署上一版本并恢复审核过的备份完成，不提供在新版本中切回 legacy 的运行时开关。
