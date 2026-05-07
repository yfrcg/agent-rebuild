# Frontend Tasks Optimized（前端任务拆解 · 优化版）

## Phase 0: 协议校准与启动验证

- [ ] Task 0: 核对真实 WS 后端
  - [ ] SubTask 0.1: 确认 `npm run gateway:ws` 可以启动
  - [ ] SubTask 0.2: 确认 WS URL 为 `ws://127.0.0.1:8787/v1/ws`
  - [ ] SubTask 0.3: 运行 `npm run gateway:smoke:ws`
  - [ ] SubTask 0.4: 阅读并记录以下文件的协议事实：
    - `packages/gateway/ws/protocol.ts`
    - `packages/gateway/ws/schemas.ts`
    - `packages/gateway/ws/router.ts`
    - `packages/gateway/ws/wsServer.ts`
  - [ ] SubTask 0.5: 确认前端不得依赖未实现字段：`connect_ok`、`eventId`、`afterSeq`、`chat.completed.payload.lastSeq`

---

## Phase 1: WS Client SDK (`packages/ws-client`)

- [ ] Task 1: 创建 `packages/ws-client` 包结构
  - [ ] SubTask 1.1: 初始化 `package.json`
  - [ ] SubTask 1.2: 初始化 `tsconfig.json`
  - [ ] SubTask 1.3: 创建 `src/index.ts`
  - [ ] SubTask 1.4: 从 `packages/gateway/ws/protocol.ts` 导入协议类型
  - [ ] SubTask 1.5: 不在前端重复定义 method/event 字符串枚举

- [ ] Task 2: 建立 SDK 类型适配层
  - [ ] SubTask 2.1: 定义 `GatewayMethodParams`
  - [ ] SubTask 2.2: 定义 `GatewayMethodResult`
  - [ ] SubTask 2.3: 定义 `GatewayEventPayload`
  - [ ] SubTask 2.4: 定义 `GatewayClientOptions`
  - [ ] SubTask 2.5: 所有 API 方法基于 `GatewayWsMethod` 收敛
  - [ ] SubTask 2.6: 对 `unknown` payload 做安全收窄，UI 不直接假设字段存在

- [ ] Task 3: 实现连接管理器 `ConnectionManager`
  - [ ] SubTask 3.1: 建立 WebSocket 连接
  - [ ] SubTask 3.2: 支持默认 URL：`ws://127.0.0.1:8787/v1/ws`
  - [ ] SubTask 3.3: 支持 token query 或 Authorization Bearer 配置
  - [ ] SubTask 3.4: 连接成功后发送 `connect`
  - [ ] SubTask 3.5: 收到 `connect` response 且 `ok: true` 后进入 ready
  - [ ] SubTask 3.6: `connected` event 作为诊断事件处理
  - [ ] SubTask 3.7: 指数退避重连：初始 1s，最大 30s，含 jitter
  - [ ] SubTask 3.8: 认证失败 / Origin 拒绝时不重试
  - [ ] SubTask 3.9: 连接状态机：`disconnected` → `connecting` → `authenticating` → `ready` → `reconnecting`

- [ ] Task 4: 实现请求管理器 `RequestManager`
  - [ ] SubTask 4.1: 唯一 ID 生成：`web_${method}_${timestamp}_${shortId}`
  - [ ] SubTask 4.2: 请求发送前注册 Promise Map
  - [ ] SubTask 4.3: response 到达时按 `id` resolve / reject
  - [ ] SubTask 4.4: 请求超时后 reject 并清理
  - [ ] SubTask 4.5: 连接断开时 reject 所有 pending 请求
  - [ ] SubTask 4.6: response error 保留 `code/message/details`

- [ ] Task 5: 实现幂等 key 注入
  - [ ] SubTask 5.1: 为 `chat.send` 自动注入 `idempotencyKey`
  - [ ] SubTask 5.2: 为 `tool.call` 自动注入 `idempotencyKey`
  - [ ] SubTask 5.3: 为 `memory.write` 自动注入 `idempotencyKey`
  - [ ] SubTask 5.4: 为 `session.create` 自动注入 `idempotencyKey`
  - [ ] SubTask 5.5: 为 `session.bindProject` 自动注入 `idempotencyKey`
  - [ ] SubTask 5.6: 为 `approval.confirm/reject` 自动注入 `idempotencyKey`
  - [ ] SubTask 5.7: idempotency key 格式建议：`idem_${method}_${timestamp}_${shortId}`

- [ ] Task 6: 实现事件分发器 `EventDispatcher`
  - [ ] SubTask 6.1: 区分 response 与 event
  - [ ] SubTask 6.2: event 分发到类型安全 listener
  - [ ] SubTask 6.3: `on("chat.delta", handler)` 支持正确 payload 类型
  - [ ] SubTask 6.4: `chat.delta` 批处理，默认 50ms
  - [ ] SubTask 6.5: event 进入 reducer 前基于 `(sessionId, seq)` 去重
  - [ ] SubTask 6.6: `state.resync_required` 触发 ResumeManager full resync

- [ ] Task 7: 实现断线恢复 `ResumeManager`
  - [ ] SubTask 7.1: 每个 session 持久化 `lastSeq`
  - [ ] SubTask 7.2: `lastSeq` 来源为已处理的 `WsEvent.seq`
  - [ ] SubTask 7.3: 重连 connect 时携带 `resume: { sessionId, lastSeq }`
  - [ ] SubTask 7.4: 收到 replay 事件后正常走 EventDispatcher
  - [ ] SubTask 7.5: 收到 `state.resync_required` 后执行 full resync
  - [ ] SubTask 7.6: full resync 包括 `runtime.status`、`session.get`、`session.getTranscript`、`approval.list`、`audit.tail`
  - [ ] SubTask 7.7: 不使用当前后端未实现的 `afterSeq` 或 `eventId`

- [ ] Task 8: 实现顶层 `GatewayClient`
  - [ ] SubTask 8.1: 组合 ConnectionManager、RequestManager、EventDispatcher、ResumeManager
  - [ ] SubTask 8.2: 暴露 `connect()` / `disconnect()`
  - [ ] SubTask 8.3: 暴露 `runtime.status`
  - [ ] SubTask 8.4: 暴露 `session.list/create/get/rename/bindProject/getTranscript`
  - [ ] SubTask 8.5: 暴露 `chat.send/cancel`
  - [ ] SubTask 8.6: 暴露 `memory.search/write`
  - [ ] SubTask 8.7: 暴露 `tool.list/call`
  - [ ] SubTask 8.8: 暴露 `approval.list/confirm/reject`
  - [ ] SubTask 8.9: 暴露 `audit.tail`
  - [ ] SubTask 8.10: Token 不进入日志、不进入 localStorage 明文

- [ ] Task 9: 编写 ws-client 单元测试
  - [ ] SubTask 9.1: connect 成功与失败
  - [ ] SubTask 9.2: 认证失败不重试
  - [ ] SubTask 9.3: request/response resolve
  - [ ] SubTask 9.4: request timeout
  - [ ] SubTask 9.5: 连接断开 reject pending
  - [ ] SubTask 9.6: delta 批处理
  - [ ] SubTask 9.7: resume 使用 connect.params.resume
  - [ ] SubTask 9.8: `(sessionId, seq)` 去重
  - [ ] SubTask 9.9: 幂等 key 注入

---

## Phase 2: Web UI 基础框架 (`apps/web-ui`)

- [ ] Task 10: 初始化 Web UI 项目
  - [ ] SubTask 10.1: 使用 Vite + React + TypeScript 初始化
  - [ ] SubTask 10.2: 引入 `packages/ws-client`
  - [ ] SubTask 10.3: 配置 UI 库与状态管理
  - [ ] SubTask 10.4: 配置 `dev` 脚本
  - [ ] SubTask 10.5: 配置与 Gateway WS 的本地连接地址

- [ ] Task 11: 创建四区域布局骨架
  - [ ] SubTask 11.1: 顶部 Status Bar
  - [ ] SubTask 11.2: 左侧 Session Sidebar
  - [ ] SubTask 11.3: 中间 Run Console
  - [ ] SubTask 11.4: 右侧 Timeline Panel
  - [ ] SubTask 11.5: 移动端 Drawer 布局

- [ ] Task 12: 实现状态层
  - [ ] SubTask 12.1: `connectionStore`
  - [ ] SubTask 12.2: `sessionStore`
  - [ ] SubTask 12.3: `runStore`
  - [ ] SubTask 12.4: `eventStore`
  - [ ] SubTask 12.5: `approvalStore`
  - [ ] SubTask 12.6: `memoryStore`
  - [ ] SubTask 12.7: `auditStore`

- [ ] Task 13: 实现 Run 状态机
  - [ ] SubTask 13.1: 八状态：idle/starting/running/streaming/completed/cancelling/cancelled/failed
  - [ ] SubTask 13.2: 正常流：idle → starting → running → streaming → completed
  - [ ] SubTask 13.3: 取消流：running/streaming → cancelling → cancelled
  - [ ] SubTask 13.4: 失败流：starting/running/streaming → failed
  - [ ] SubTask 13.5: completed/cancelled/failed 不可被迟到事件覆盖

---

## Phase 3: 核心页面

- [ ] Task 14: Gateway Dashboard
  - [ ] SubTask 14.1: 调用 `runtime.status`
  - [ ] SubTask 14.2: 显示 model/debug/sandboxMode
  - [ ] SubTask 14.3: 显示 toolCount/sessionCount/currentSessionId
  - [ ] SubTask 14.4: 显示 metrics/wsMetrics
  - [ ] SubTask 14.5: 字段缺失时 UI 降级显示 unknown

- [ ] Task 15: Session Workspace
  - [ ] SubTask 15.1: `session.list`
  - [ ] SubTask 15.2: `session.create`
  - [ ] SubTask 15.3: `session.get`
  - [ ] SubTask 15.4: `session.rename`
  - [ ] SubTask 15.5: `session.bindProject`
  - [ ] SubTask 15.6: `session.getTranscript`
  - [ ] SubTask 15.7: 每个 session 保存 lastSeq

- [ ] Task 16: Run Console
  - [ ] SubTask 16.1: 输入框与发送按钮
  - [ ] SubTask 16.2: `chat.send` 创建 run
  - [ ] SubTask 16.3: `run.started` 更新状态
  - [ ] SubTask 16.4: `chat.delta` 批处理显示
  - [ ] SubTask 16.5: `chat.completed.payload.text` 覆盖最终文本
  - [ ] SubTask 16.6: `chat.cancel` 只发送 `{ runId }`
  - [ ] SubTask 16.7: 取消不显示为错误
  - [ ] SubTask 16.8: transcript 历史加载

- [ ] Task 17: Tool Timeline
  - [ ] SubTask 17.1: 纵向事件流
  - [ ] SubTask 17.2: 按 seq 排序
  - [ ] SubTask 17.3: 展示 `tool.started/finished/denied/failed`
  - [ ] SubTask 17.4: 支持 runId/sessionId/toolName/status 过滤
  - [ ] SubTask 17.5: payload 默认折叠
  - [ ] SubTask 17.6: 支持 copy JSON
  - [ ] SubTask 17.7: tool denied 不自动重试

- [ ] Task 18: Approval Center
  - [ ] SubTask 18.1: `approval.list`
  - [ ] SubTask 18.2: 检查 expiresAt
  - [ ] SubTask 18.3: `approval.confirm`
  - [ ] SubTask 18.4: `approval.reject`
  - [ ] SubTask 18.5: 操作成功后从 pending 列表移除
  - [ ] SubTask 18.6: 过期项置灰

- [ ] Task 19: Memory Panel
  - [ ] SubTask 19.1: `memory.search`
  - [ ] SubTask 19.2: 展示 chunkId/fileId/section/filePath/score/snippet
  - [ ] SubTask 19.3: `memory.write`
  - [ ] SubTask 19.4: 只允许 content/scope/sessionId
  - [ ] SubTask 19.5: 不允许前端构造任意路径

- [ ] Task 20: Audit Panel
  - [ ] SubTask 20.1: `audit.tail`
  - [ ] SubTask 20.2: 展示最近 N 条
  - [ ] SubTask 20.3: 支持 type/sessionId/runId/toolName 过滤
  - [ ] SubTask 20.4: 默认摘要视图
  - [ ] SubTask 20.5: 敏感字段 `[REDACTED]`
  - [ ] SubTask 20.6: 不提供任意文件读取入口

---

## Phase 4: 视觉设计与可靠性

- [ ] Task 21: 深色控制台主题
  - [ ] SubTask 21.1: 深色背景
  - [ ] SubTask 21.2: 高对比文字
  - [ ] SubTask 21.3: monospace payload
  - [ ] SubTask 21.4: 避免大面积紫色 SaaS 风格

- [ ] Task 22: 状态色
  - [ ] SubTask 22.1: running 蓝
  - [ ] SubTask 22.2: success 绿
  - [ ] SubTask 22.3: warning 琥珀
  - [ ] SubTask 22.4: denied/failed 红
  - [ ] SubTask 22.5: cancelled 灰
  - [ ] SubTask 22.6: resync 特殊提示

- [ ] Task 23: 大 payload 处理
  - [ ] SubTask 23.1: JSON 默认折叠
  - [ ] SubTask 23.2: lazy render
  - [ ] SubTask 23.3: copy JSON
  - [ ] SubTask 23.4: payload 字段缺失时不崩溃

- [ ] Task 24: 移动端适配
  - [ ] SubTask 24.1: Session + Chat 优先
  - [ ] SubTask 24.2: Timeline/Audit 进入 Drawer
  - [ ] SubTask 24.3: 输入框固定底部
  - [ ] SubTask 24.4: payload 折叠显示

---

## Phase 5: 集成验证

- [ ] Task 25: 真实 WS 端到端验证
  - [ ] SubTask 25.1: 启动 `npm run gateway:ws`
  - [ ] SubTask 25.2: 连接 `ws://127.0.0.1:8787/v1/ws`
  - [ ] SubTask 25.3: connect 成功
  - [ ] SubTask 25.4: runtime.status 成功
  - [ ] SubTask 25.5: session.list 成功
  - [ ] SubTask 25.6: chat.send 收到 run.started
  - [ ] SubTask 25.7: chat.completed 能覆盖最终文本
  - [ ] SubTask 25.8: audit.tail 成功

- [ ] Task 26: 断线恢复验证
  - [ ] SubTask 26.1: 运行中断开 WS
  - [ ] SubTask 26.2: 重连时带 resume
  - [ ] SubTask 26.3: replay 事件不重复
  - [ ] SubTask 26.4: replay 不可用时触发 resync
  - [ ] SubTask 26.5: resync 后 UI 状态可恢复

- [ ] Task 27: 多 session 并发验证
  - [ ] SubTask 27.1: 两个 session 同时存在
  - [ ] SubTask 27.2: 每个 session 独立 lastSeq
  - [ ] SubTask 27.3: activeRunIds 不串 session
  - [ ] SubTask 27.4: timeline 可按 session 过滤

- [ ] Task 28: 编译与测试
  - [ ] SubTask 28.1: `npm run typecheck`
  - [ ] SubTask 28.2: `npm run build`
  - [ ] SubTask 28.3: ws-client 单元测试
  - [ ] SubTask 28.4: Web UI 组件测试
  - [ ] SubTask 28.5: E2E smoke 测试

---

## Task Dependencies

- Task 0 是所有任务前置
- Task 2 依赖 Task 1
- Task 3-8 依赖 Task 1-2
- Task 9 依赖 Task 3-8
- Task 10-13 依赖 Task 8
- Task 14-20 依赖 Task 10-13
- Task 21-24 可与 Task 14-20 并行
- Task 25-28 依赖核心功能完成
