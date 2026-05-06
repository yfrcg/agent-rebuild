# Tasks

## Phase 1: WS Client SDK (`packages/ws-client`)

- [ ] Task 1: 创建 `packages/ws-client` 包结构
  - [ ] SubTask 1.1: 初始化 `package.json`、`tsconfig.json`，依赖 `ws` 和项目内 `protocol.ts` 类型
  - [ ] SubTask 1.2: 创建 `src/index.ts` 导出入口
  - [ ] SubTask 1.3: 从 `packages/gateway/ws/protocol.ts` 共享类型定义，前端不重新定义

- [ ] Task 2: 实现连接管理器 `ConnectionManager`
  - [ ] SubTask 2.1: WebSocket 连接建立与 `connect` 握手（protocolVersion: "1.0", clientName）
  - [ ] SubTask 2.2: 指数退避重连（初始 1s，最大 30s，含 jitter）
  - [ ] SubTask 2.3: 连接状态机（`disconnected` → `connecting` → `authenticating` → `connected`）
  - [ ] SubTask 2.4: 认证失败处理（token 错误时不重试，其他失败时退避重试）
  - [ ] SubTask 2.5: 可选认证支持（token 可选时的降级处理）

- [ ] Task 3: 实现请求/响应 Promise Map `RequestManager`
  - [ ] SubTask 3.1: 唯一 ID 生成（`web_${method}_${timestamp}_${shortId}`）
  - [ ] SubTask 3.2: 发送请求并注册 Promise，响应到达时 resolve/reject
  - [ ] SubTask 3.3: 请求超时处理与清理
  - [ ] SubTask 3.4: 副作用方法自动注入 `idempotencyKey`（`chat.send`、`tool.call`、`memory.write`、`session.bindProject`、`approval.confirm`、`approval.reject`）
  - [ ] SubTask 3.5: 连接断开时 reject 所有 pending 请求

- [ ] Task 4: 实现事件 Reducer `EventDispatcher`
  - [ ] SubTask 4.1: server event 分发到注册的 listener
  - [ ] SubTask 4.2: `chat.delta` 批处理（30-80ms 合并）
  - [ ] SubTask 4.3: `state.resync_required` 自动触发 resync 流程
  - [ ] SubTask 4.4: 事件类型安全的 listener 注册 API（`on("chat.delta", handler)`）

- [ ] Task 5: 实现断线恢复 `ResumeManager`
  - [ ] SubTask 5.1: 每个 session 持久化 `lastSeq`
  - [ ] SubTask 5.2: 重连后对活跃 session 发送 `session.getTranscript`（`afterSeq: lastSeq`）
  - [ ] SubTask 5.3: 对比 `chat.completed.payload.lastSeq` 和本地 `lastSeq`，存在间隙时发送 `audit.tail` 补齐
  - [ ] SubTask 5.4: 去重处理（基于 `eventId`）

- [ ] Task 6: 实现顶层 `GatewayClient` 门面
  - [ ] SubTask 6.1: 组合 ConnectionManager、RequestManager、EventDispatcher、ResumeManager
  - [ ] SubTask 6.2: 暴露类型安全的 API 方法（`chat.send`、`session.list` 等）
  - [ ] SubTask 6.3: 自动 `connect` 握手
  - [ ] SubTask 6.4: Token 管理（不进入日志，不进入 localStorage 明文）

- [ ] Task 7: 编写 ws-client 单元测试
  - [ ] SubTask 7.1: 连接管理测试（连接、断开、重连、认证失败）
  - [ ] SubTask 7.2: 请求/响应测试（成功、超时、连接断开）
  - [ ] SubTask 7.3: 事件分发测试（delta 批处理、resync 触发）
  - [ ] SubTask 7.4: 断线恢复测试（lastSeq 管理、gap 检测、去重）
  - [ ] SubTask 7.5: 幂等 key 注入测试

## Phase 2: Web UI 基础框架 (`apps/web-ui`)

- [ ] Task 8: 初始化 Web UI 项目
  - [ ] SubTask 8.1: 使用 Vite + React + TypeScript 初始化 `apps/web-ui`
  - [ ] SubTask 8.2: 配置依赖（`packages/ws-client`、UI 库、状态管理）
  - [ ] SubTask 8.3: 创建四区域布局骨架（左/中/右/顶）

- [ ] Task 9: 实现状态层
  - [ ] SubTask 9.1: `connectionStore` — WS 连接状态、重连计数、认证状态
  - [ ] SubTask 9.2: `sessionStore` — Session 列表、当前 session、lastSeq、transcriptCache
  - [ ] SubTask 9.3: `runStore` — Run 状态机、activeRunIds、delta 缓冲
  - [ ] SubTask 9.4: `eventStore` — 事件时间线、seq 索引、过滤
  - [ ] SubTask 9.5: `approvalStore` — 待审批列表、操作状态

- [ ] Task 10: 实现 Run 状态机
  - [ ] SubTask 10.1: 七状态有限状态机（idle/starting/running/streaming/completed/cancelling/cancelled/failed）
  - [ ] SubTask 10.2: 状态转换规则（正常流、取消流、失败流）
  - [ ] SubTask 10.3: 状态不可逆保护（completed/cancelled/failed 不可覆盖）

## Phase 3: 核心页面

- [ ] Task 11: Session Workspace 页面
  - [ ] SubTask 11.1: Session 列表（`session.list`）
  - [ ] SubTask 11.2: Session 创建（`session.create`）
  - [ ] SubTask 11.3: Session 详情（`session.get`）
  - [ ] SubTask 11.4: Session 绑定项目（`session.bindProject`）

- [ ] Task 12: Run Console 页面
  - [ ] SubTask 12.1: 消息输入与发送（`chat.send`）
  - [ ] SubTask 12.2: 流式文本渲染（`chat.delta` 批处理 + `chat.completed` 最终文本）
  - [ ] SubTask 12.3: 取消按钮（`chat.cancel`，取消不显示为错误）
  - [ ] SubTask 12.4: Transcript 历史加载（`session.getTranscript`）

- [ ] Task 13: Tool Timeline 页面
  - [ ] SubTask 13.1: 纵向事件流，按 seq 排序
  - [ ] SubTask 13.2: `tool.started` / `tool.finished` / `tool.denied` / `tool.failed` 展示
  - [ ] SubTask 13.3: Tool payload 默认折叠，提供 copy JSON
  - [ ] SubTask 13.4: 支持按 runId/sessionId 过滤

- [ ] Task 14: Approval Center 页面
  - [ ] SubTask 14.1: 待审批列表（`approval.list`），检查 `expiresAt`
  - [ ] SubTask 14.2: 确认/拒绝操作（`approval.confirm` / `approval.reject`）

- [ ] Task 15: Memory Panel 页面
  - [ ] SubTask 15.1: 搜索界面（`memory.search`）
  - [ ] SubTask 15.2: 写入界面（`memory.write`，只提供 content/scope）

- [ ] Task 16: Gateway Dashboard 页面
  - [ ] SubTask 16.1: `runtime.status` 展示
  - [ ] SubTask 16.2: `ws.metrics` 展示
  - [ ] SubTask 16.3: 连接状态、模型、sandbox、tool count、active runs

- [ ] Task 17: Audit Panel 页面
  - [ ] SubTask 17.1: `audit.tail` 基础视图
  - [ ] SubTask 17.2: 默认只显示摘要，敏感字段 `[REDACTED]`

## Phase 4: 集成与收尾

- [ ] Task 18: 断线重连与 resync 集成
  - [ ] SubTask 18.1: 指数退避重连 UI 指示
  - [ ] SubTask 18.2: `state.resync_required` 处理后 UI 刷新
  - [ ] SubTask 18.3: lastSeq 持久化（sessionStorage）

- [ ] Task 19: 视觉设计实现
  - [ ] SubTask 19.1: 深色控制台主题
  - [ ] SubTask 19.2: 状态色（running 蓝、success 绿、warning 琥珀、denied 红、cancelled 灰）
  - [ ] SubTask 19.3: monospace 字体用于代码和事件 payload
  - [ ] SubTask 19.4: 移动端适配（session/chat 优先，timeline/audit 进抽屉）

- [ ] Task 20: 端到端验证
  - [ ] SubTask 20.1: 与真实 Gateway WS 端到端测试
  - [ ] SubTask 20.2: 断线恢复验证
  - [ ] SubTask 20.3: 多 session 并发验证
  - [ ] SubTask 20.4: TypeScript 编译零错误

# Task Dependencies

- Task 2-6 依赖 Task 1（包结构）
- Task 7 依赖 Task 2-6（SDK 实现）
- Task 8 依赖 Task 1（SDK 包）
- Task 9-10 依赖 Task 8（UI 框架）
- Task 11-17 依赖 Task 9-10（状态层 + Run 状态机）
- Task 18 依赖 Task 5 + Task 8（ResumeManager + UI）
- Task 19 依赖 Task 8（UI 框架）
- Task 20 依赖 Task 18-19（集成 + 视觉）
