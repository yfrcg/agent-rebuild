# Frontend Checklist Optimized（前端验收清单 · 优化版）

## 0. 协议一致性

- [ ] 使用真实后端 WS URL：`ws://127.0.0.1:8787/v1/ws`
- [ ] 可通过 `npm run gateway:ws` 启动后端
- [ ] 可通过 `npm run gateway:smoke:ws` 通过基础 smoke
- [ ] 协议类型从 `packages/gateway/ws/protocol.ts` 共享
- [ ] 前端不重新定义 method/event 字符串枚举
- [ ] `connect` 成功判断基于 response `ok: true`
- [ ] 不等待不存在的 `connect_ok`
- [ ] `connected` event 只作为诊断事件
- [ ] `chat.cancel` 请求参数与后端 schema 对齐：只要求 `runId`
- [ ] `session.getTranscript` 不传当前未实现的 `afterSeq`
- [ ] `audit.tail` 不传当前未实现的 `afterSeq`
- [ ] 不依赖当前协议不存在的 `eventId`
- [ ] 不依赖 `chat.completed.payload.lastSeq`

---

## 1. WS Client SDK

- [ ] `packages/ws-client` 包结构完整
- [ ] `package.json`、`tsconfig.json`、`src/index.ts` 完整
- [ ] 定义 `GatewayMethodParams`
- [ ] 定义 `GatewayMethodResult`
- [ ] 定义 `GatewayEventPayload`
- [ ] UI 组件不直接使用原生 WebSocket
- [ ] SDK 暴露 `GatewayClient`
- [ ] SDK 支持 connect/disconnect
- [ ] SDK 支持 runtime/session/chat/memory/tool/approval/audit API
- [ ] SDK 对 unknown payload 做安全收窄
- [ ] 字段缺失时不导致 UI 崩溃

---

## 2. 连接管理

- [ ] 初始连接后立即发送 `connect`
- [ ] connect params 包含 `protocolVersion: "1.0"`
- [ ] connect params 包含 `clientName: "web-ui"`
- [ ] 收到 `connect` response `ok: true` 后进入 ready
- [ ] 连接状态机完整：
  - [ ] disconnected
  - [ ] connecting
  - [ ] authenticating
  - [ ] ready
  - [ ] reconnecting
- [ ] 支持指数退避重连
- [ ] 初始重连间隔 1s
- [ ] 最大重连间隔 30s
- [ ] 重连包含 jitter
- [ ] 认证失败不重试
- [ ] Origin 拒绝不重试
- [ ] 连接断开时 reject 所有 pending 请求
- [ ] 心跳或 server.shutdown 可更新连接状态

---

## 3. 认证与安全

- [ ] 支持无 token 本地模式
- [ ] 支持 query token
- [ ] 支持 Authorization Bearer
- [ ] Token 不写入 console log
- [ ] Token 不写入 localStorage 明文
- [ ] Token 不显示在 UI 明文区域
- [ ] 认证失败显示明确错误
- [ ] Browser Origin 与 `GATEWAY_WS_ALLOWED_ORIGINS` 对齐
- [ ] Memory write 不构造任意路径
- [ ] Tool denied 不自动重试
- [ ] Audit 只显示 redacted 数据
- [ ] 不提供任意文件读取入口

---

## 4. RequestManager

- [ ] 请求 ID 全局唯一
- [ ] 请求 ID 格式建议：`web_${method}_${timestamp}_${shortId}`
- [ ] Promise Map 正确注册
- [ ] response 按 `id` resolve/reject
- [ ] timeout 后 reject 并清理
- [ ] 连接断开 reject pending
- [ ] response error 保留 code/message/details
- [ ] request/response 不与 event 混用

---

## 5. 幂等 key

- [ ] `chat.send` 自动注入 `idempotencyKey`
- [ ] `tool.call` 自动注入 `idempotencyKey`
- [ ] `memory.write` 自动注入 `idempotencyKey`
- [ ] `session.create` 自动注入 `idempotencyKey`
- [ ] `session.bindProject` 自动注入 `idempotencyKey`
- [ ] `approval.confirm` 自动注入 `idempotencyKey`
- [ ] `approval.reject` 自动注入 `idempotencyKey`
- [ ] 重试同一副作用请求不会重复创建资源
- [ ] 幂等失败能向 UI 暴露 CONFLICT / failed 状态

---

## 6. EventDispatcher

- [ ] server event 进入 event reducer
- [ ] listener 类型安全：`on("chat.delta", handler)`
- [ ] `chat.delta` 支持 30-80ms 批处理
- [ ] 默认批处理间隔 50ms
- [ ] 事件按 `seq` 排序
- [ ] 基于 `(sessionId, seq)` 去重
- [ ] `state.resync_required` 自动触发 full resync
- [ ] `server.shutdown` 显示关停提示
- [ ] 迟到事件不会覆盖终态 run

---

## 7. 断线恢复

- [ ] 每个 session 持久化 `lastSeq`
- [ ] `lastSeq` 来源为最后处理的 `WsEvent.seq`
- [ ] 重连 connect 携带 `resume: { sessionId, lastSeq }`
- [ ] replay 事件能够进入正常 reducer
- [ ] replay 事件不重复显示
- [ ] 收到 `state.resync_required` 后执行 full resync
- [ ] full resync 包含 `runtime.status`
- [ ] full resync 包含 `session.get`
- [ ] full resync 包含 `session.getTranscript`
- [ ] full resync 包含 `approval.list`
- [ ] full resync 包含 `audit.tail`
- [ ] ReplayBuffer 丢失时 UI 有明确提示

---

## 8. Web UI 基础

- [ ] `apps/web-ui` 已初始化
- [ ] Vite + React + TypeScript 可运行
- [ ] 引入 `packages/ws-client`
- [ ] 顶部 Status Bar 完成
- [ ] 左侧 Session Sidebar 完成
- [ ] 中间 Run Console 完成
- [ ] 右侧 Timeline Panel 完成
- [ ] 移动端 Drawer 布局完成
- [ ] 状态层拆分完成：
  - [ ] connectionStore
  - [ ] sessionStore
  - [ ] runStore
  - [ ] eventStore
  - [ ] approvalStore
  - [ ] memoryStore
  - [ ] auditStore

---

## 9. Run 状态机

- [ ] 实现八状态：
  - [ ] idle
  - [ ] starting
  - [ ] running
  - [ ] streaming
  - [ ] completed
  - [ ] cancelling
  - [ ] cancelled
  - [ ] failed
- [ ] 正常流程正确：idle → starting → running → streaming → completed
- [ ] 取消流程正确：running/streaming → cancelling → cancelled
- [ ] 失败流程正确：starting/running/streaming → failed
- [ ] completed 不可被后续 delta 覆盖
- [ ] cancelled 不可被后续事件覆盖
- [ ] failed 不可被后续普通事件覆盖
- [ ] 取消不显示为错误
- [ ] runId/sessionId 关联正确

---

## 10. 核心页面

### Gateway Dashboard

- [ ] 调用 `runtime.status`
- [ ] 显示 model
- [ ] 显示 debug
- [ ] 显示 sandboxMode
- [ ] 显示 toolCount
- [ ] 显示 sessionCount
- [ ] 显示 currentSessionId
- [ ] 显示 metrics
- [ ] 显示 wsMetrics
- [ ] 字段缺失时降级显示 unknown

### Session Workspace

- [ ] `session.list` 可用
- [ ] `session.create` 可用
- [ ] `session.get` 可用
- [ ] `session.rename` 可用
- [ ] `session.bindProject` 可用
- [ ] `session.getTranscript` 可用
- [ ] Session 显示 name/messageCount/updatedAt/permission
- [ ] projectBound 状态清晰
- [ ] 每个 session 独立 lastSeq

### Run Console

- [ ] `chat.send` 可用
- [ ] `run.started` 后进入 running
- [ ] `chat.delta` 实时显示
- [ ] delta 批处理不卡顿
- [ ] `chat.completed.payload.text` 覆盖最终文本
- [ ] `run.finished` 正常结束
- [ ] `run.failed` 显示错误
- [ ] `chat.cancel` 可用
- [ ] cancel 只发送 `{ runId }`
- [ ] transcript 历史可加载

### Tool Timeline

- [ ] `tool.list` 可用
- [ ] `tool.call` 可用
- [ ] `tool.started` 展示
- [ ] `tool.finished` 展示
- [ ] `tool.denied` 展示
- [ ] `tool.failed` 展示
- [ ] 按 seq 排序
- [ ] 支持 runId/sessionId/toolName/status 过滤
- [ ] payload 默认折叠
- [ ] 支持 copy JSON
- [ ] 大 payload lazy render

### Approval Center

- [ ] `approval.list` 可用
- [ ] 显示 token/toolName/input preview/expiresAt/message
- [ ] 前端检查 expiresAt
- [ ] 过期项置灰
- [ ] `approval.confirm` 可用
- [ ] `approval.reject` 可用
- [ ] confirm/reject 后列表更新
- [ ] 操作失败有错误提示

### Memory Panel

- [ ] `memory.search` 可用
- [ ] 显示 chunkId/fileId/section/filePath/score/snippet
- [ ] `memory.write` 可用
- [ ] 写入只提供 content/scope/sessionId
- [ ] 不构造任意路径
- [ ] 写入结果只读展示 filePath/scope

### Audit Panel

- [ ] `audit.tail` 可用
- [ ] `audit.append` 能进入 timeline
- [ ] 默认摘要视图
- [ ] 支持 type/sessionId/runId/toolName 过滤
- [ ] 敏感字段显示 `[REDACTED]`
- [ ] 不显示原始 token
- [ ] 不提供任意文件读取入口

---

## 11. 视觉设计

- [ ] 深色控制台主题
- [ ] 工程化，不像普通聊天 SaaS
- [ ] 避免大面积紫色默认风
- [ ] 状态色正确：
  - [ ] running 蓝
  - [ ] success 绿
  - [ ] warning 琥珀
  - [ ] denied 红
  - [ ] failed 红
  - [ ] cancelled 灰
- [ ] monospace 用于代码、日志、payload
- [ ] Timeline 纵向事件流
- [ ] payload 默认折叠
- [ ] 大 JSON 不一次性展开
- [ ] 移动端 Session + Chat 优先
- [ ] Timeline/Audit 移动端进入 Drawer

---

## 12. 集成验证

- [ ] `npm run gateway:ws` 启动成功
- [ ] Web UI 成功连接真实 Gateway
- [ ] connect 握手成功
- [ ] runtime.status 成功
- [ ] session.list 成功
- [ ] session.create 成功
- [ ] chat.send 成功创建 run
- [ ] 能收到 run.started
- [ ] 能收到 chat.delta 或在无流式时正常等待 completed
- [ ] 能收到 chat.completed
- [ ] chat.completed 最终文本正确显示
- [ ] chat.cancel 成功
- [ ] memory.search 成功
- [ ] memory.write 成功
- [ ] tool.list 成功
- [ ] audit.tail 成功
- [ ] 断线重连成功
- [ ] resume 成功补发事件
- [ ] replay 不可用时 resync 成功
- [ ] 多 session 并发不串状态
- [ ] TypeScript 编译零错误
- [ ] 单元测试通过
- [ ] E2E smoke 通过
