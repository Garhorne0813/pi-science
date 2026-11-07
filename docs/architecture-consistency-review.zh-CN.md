# 状态、传输与应用组装复核

本次复核确认了报告中的具体代码路径。项目仍适合模块化单体：科研工作台的状态权威、进程隔离和权限边界，比拆分部署单元更需要优先维护。

| 项目 | 核实结果 | 本次处理 |
| --- | --- | --- |
| 1. SSE 背压 | 存在。队列清空会覆盖 `push(false)` 的阻塞状态；Execution 直接写 socket | 会话和 Execution 共用 `BoundedSseStream`。仅 `_read()` 解锁，应用队列与 Readable 缓冲共用 512 KiB 字节预算，溢出断开并释放订阅。响应在回放前开始发送，回放按字节批次让出事件循环；补慢消费者、恢复顺序和 2 MiB 回放测试 |
| 2. Job / Execution 状态 | 存在。终态查询不修复投影，异常被吞掉 | Job 作为权威来源；终态读取、启动和每 30 秒后台对账幂等补写投影，失败记录日志。关闭时排空对账和任务。SQLite 关闭重开故障测试覆盖“Job 保存成功、Execution 写入失败” |
| 3. 权限回调接线 | 存在。`sessionServer` 丢失两个回调 | 合并为一个 `SessionServerOptions` 对象；生产组装要求资源探测、撤销和退出回调；真实模块组装测试验证内核撤销 |
| 4. HTTP 契约 | 存在。`limit=abc` 可进入服务，存储异常被转成 400 | Job body/query/params、Prompt 和审批响应使用共享运行时 schema；Job 错误统一为 `{ error: { code, message, fields? }, request_id }`。输入/冲突/能力不足/内部错误分别映射。全局 4xx 保留错误消息，前端支持新错误结构 |
| 5. Execution 历史成本 | 存在。写入使快照失效并重新扫描全部 JSONL | 增加按 execution ID 的记录与 sequence 索引；本进程追加后增量更新，其他写入者或文件替换后重新加载。测试验证 20 个完整生命周期仅首次读取历史，外部追加后重新加载 |
| 6. 路由业务编排 | 存在。Prompt 和审批流程均绑定 HTTP | 提取 `PromptSubmissionService`、`ApprovalInteractionService`；锁、持久化、投递不确定状态与审批完成流程进入用例。生产应用统一组装用例及 Job/Kernel/HTTP 使用的 Execution repository |
| 7. 幂等与异步语义 | 存在。Job 重试会重复执行，Prompt 允许无 ID | Job 支持 body `idempotency_key` 和 `Idempotency-Key` header，工作区隔离，持久状态保存内容摘要；并发和重启后重试返回相同任务，内容冲突为 409。Job 返回 202 + Location；创建会话返回 201 + Location；新增 `POST /jobs/:id/cancel` 和要求 ID 的 `POST /sessions/:id/prompts`，前端改用后者 |
| 8. 生命周期 | 存在。重复启动/停止和全局 URL 初始化清单 | 单一启动/关闭钩子；必需状态 worker 启动失败阻止启动，遗留导入或 MCP 初始化失败使 readiness 为 503 且不启动后台生产者。先停止后台生产者、会话、任务及内核，最后关闭存储；个别关闭失败仍继续释放其他资源。环境准备进入 Kernel/Notebook 对应用例 |

## 保留的契约与边界

- 会话 SSE 是带 cursor 的恢复流；Execution SSE 是刷新通知流。Execution 消费者在重连时重新查询 REST，不承诺通知重放。
- `POST /sessions/:id/prompt` 保留无 ID 的兼容行为，并通过 Deprecation / Link 标注新入口；`DELETE /jobs/:id` 保留取消行为。新入口和兼容入口共享幂等记录。
- Job 幂等请求以调用者提供的请求体为内容边界，字段顺序不影响摘要；相同键和不同请求体返回 409。无幂等键仍是兼容提交，每次创建任务。幂等保证依赖任务历史保留；不会自动重跑已失败任务。
- Execution 默认保持首个终态不变。只有绑定同一 `correlation.job_id` 的权威 Job 对账可以修正先前失败的提交/投影尝试；修正也追加事件，重复相同终态不会追加。
- 模块级 Execution 导出仍用于未迁移的 Agent/远程计算入口；这些入口与应用拥有的 repository 通过同一工作区文件和跨进程锁保持数据一致。

## 尚未实施的大范围迁移

以下建议仍成立，不能把本次修补视为已完成这些迁移：

1. Job 状态与 SQLite outbox 的同事务写入。本次通过持久 Job 的定期重投影实现最终一致，列表接口只读取 Execution 投影，不同步读取历史 Job；提交和完成时正常更新投影，失败后由启动及每 30 秒后台对账恢复（实际延迟还包括扫描耗时，失败会记录日志并在下一周期重试）。需要即时检查单个任务时，Job 读取和 Execution 详情会触发单任务修复。SQLite 工作区在重启时自动发现；文件后端使用持久 Job 工作区索引，并从托管根目录、已注册和固定目录发现旧工作区、回填索引。不扫描任意未登记目录；这些目录需先注册或固定。
2. Execution 全量迁入 SQLite，以及索引查询和游标分页。本次消除了常见单进程连续追加的全量扫描；冷启动、外部写入、缓存淘汰后仍读取历史，列表筛选排序仍随记录数增长。缓存上限仍为四个文件、总计 100,000 条记录。
3. 所有历史 HTTP 路由统一切换结构化错误，以及从 schema 生成全量 OpenAPI。目前新 Job 接口采用新错误契约，其他路由保留现有兼容结构；共享 schema 和客户端错误读取已经准备好。
4. Agent/远程计算等剩余入口的 Execution repository / 事件通知总线依赖注入。当前文件锁与元数据校验仍是跨 repository 和跨进程一致性边界。
