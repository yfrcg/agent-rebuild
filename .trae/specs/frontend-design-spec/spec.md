# Frontend Design Spec (前端设计规范)

## Why

后端 Gateway 已达到生产级本地 Agent 基础设施水平，包含完整的 WS 协议、安全链路、Run 生命周期、Memory、Audit 和 29 个内置工具。现在需要一个类型安全的 WS Client SDK 和 Web UI 控制台，将后端能力暴露给用户。前端不是普通聊天页，而是 **Local Agent Control Console**——会话 + 运行轨迹 + 工具调用 + 审批 + 审计的工作台。

## What Changes

- 新增 `packages/ws-client`：类型安全的 WS Client SDK，封装连接管理、请求/响应 Promise map、事件 reducer、断线重连与 resume
- 新增 `apps/web-ui`：基于 React + TypeScript 的 Web UI 控制台
- 前端规范覆盖：信息架构、核心页面、Run 状态机、流式渲染、安全交互、视觉设计
- 所有 server 事件类型从 `protocol.ts` 共享，前端不重新定义

## Impact

- Affected specs: 无（全新前端层）
- Affected code:
  - `packages/gateway/ws/protocol.ts` — WS 协议定义，前端 SDK 的类型来源
  - `packages/gateway/ws/schemas.ts` — 消息 schema，前端验证参考
  - `packages/gateway/ws/router.ts` — 请求路由，前端 API surface 参考
  - `packages/gateway/sessionTypes.ts` — Session 数据结构
  - `packages/gateway/types.ts` — Gateway 响应/调试/指标结构
  - `packages/gateway/toolCallTypes.ts` — Tool Call 记录结构

---

## 一、产品定位

### Requirement: Local Agent Control Console

前端 SHALL 作为多 Agent Gateway 的操作台，优先支持 Web UI，后续可复用到 VS Code Client。

#### Scenario: 多会话管理
- **WHEN** 用户打开 Web UI
- **THEN** 左侧显示 Session 列表，每个 Session 显示 name、messageCount、updatedAt、projectBound 状态
- **AND** 用户可以创建新 Session、重命名、绑定项目目录

#### Scenario: 显式 Session 上下文
- **WHEN** 用户执行任何操作（chat、tool、memory、approval）
- **THEN** 所有 WS 请求 SHALL 包含显式 `sessionId` 字段
- **AND** 前端不依赖隐式 current session

#### Scenario: 一等状态管理
- **WHEN** 前端管理运行状态
- **THEN** `runId`、`sessionId`、`seq`、`idempotencyKey` SHALL 作为一等状态
- **AND** 每个 session 保存 `lastSeq`、`activeRunIds`、`transcriptCache`

---

## 二、信息架构

### Requirement: 四区域布局

#### Scenario: 标准布局
- **WHEN** 用户在桌面端查看
- **THEN** 左侧显示 Session 列表面板
- **AND** 中间显示 Chat/Run 主视图
- **AND** 右侧显示 Timeline 面板（run、tool、approval、memory、audit 事件）
- **AND** 顶部显示连接状态、当前模型、sandbox mode、tool count、active runs、WS 状态

#### Scenario: 移动端适配
- **WHEN** 用户在移动端查看
- **THEN** Session 和 Chat 优先显示
- **AND** Timeline 和 Audit 进入抽屉

---

## 三、核心页面

### Requirement: Gateway Dashboard
显示 `runtime.status` 响应中的运行时信息。

#### Scenario: Dashboard 展示
- **WHEN** 用户访问 Dashboard
- **THEN** 显示 runtime.name、version、modelProvider、model
- **AND** 显示 sandbox.mode、memory.enabled、audit.enabled
- **AND** 显示 tools.total、builtin、dynamic
- **AND** 显示 wsConnections、wsMaxConnections
- **AND** 显示 sessions.active、maxSessions
- **AND** 显示 metrics（totalRequests、errorRate、avgDurationMs、p95DurationMs、circuitState）

### Requirement: Session Workspace
基于 `session.list`、`session.create`、`session.get`、`session.bindProject`、`session.getTranscript`。

#### Scenario: Session 列表
- **WHEN** 用户发送 `session.list` 请求
- **THEN** 显示所有 session 的 id、name、messageCount、updatedAt、projectBound、permission

#### Scenario: Session 创建
- **WHEN** 用户点击创建 Session
- **THEN** 发送 `session.create` 请求（带 `idempotencyKey`）
- **AND** 新 Session 出现在列表中

#### Scenario: Session 绑定项目
- **WHEN** 用户为 Session 绑定项目目录
- **THEN** 发送 `session.bindProject` 请求（带 `idempotencyKey`）
- **AND** Session 状态更新显示 `projectBound: true`、`permission: "project-write"`

### Requirement: Run Console
基于 `chat.send`、`chat.cancel`、`chat.delta`、`chat.completed`。

#### Scenario: 发送消息
- **WHEN** 用户输入消息并发送
- **THEN** 发送 `chat.send` 请求（带 `idempotencyKey`、`sessionId`）
- **AND** Run 状态进入 `starting`
- **AND** 收到 `run.started` 事件后进入 `running`
- **AND** 收到 `chat.delta` 事件后进入 `streaming`

#### Scenario: 取消运行
- **WHEN** 用户点击取消按钮
- **THEN** 发送 `chat.cancel` 请求（带 `runId`、`sessionId`）
- **AND** Run 状态进入 `cancelling`
- **AND** 收到 `run.cancelled` 事件后进入 `cancelled`
- **AND** 取消不显示为错误，显示为用户主动取消

#### Scenario: 流式渲染
- **WHEN** 收到 `chat.delta` 事件
- **THEN** delta 仅用于实时显示，不作为最终可信文本源
- **AND** 最终文本以 `chat.completed.payload.text` 为准
- **AND** 前端对 delta 做 30-80ms UI 批处理

### Requirement: Tool Timeline
基于 `tool.started`、`tool.finished`、`tool.denied`、`tool.failed` 事件。

#### Scenario: Tool 调用展示
- **WHEN** 收到 `tool.started` 事件
- **THEN** Timeline 中显示工具名称、input preview、sessionId、风险状态
- **AND** 收到 `tool.finished` 后显示 output preview、耗时

#### Scenario: Tool 拒绝处理
- **WHEN** 收到 `tool.denied` 事件
- **THEN** 不自动重试
- **AND** 提示需要权限、绑定项目或 approval

### Requirement: Approval Center
基于 `approval.list`、`approval.confirm`、`approval.reject`。

#### Scenario: 审批列表
- **WHEN** 用户查看 Approval Center
- **THEN** 显示所有待审批项的 token、toolName、input preview、expiresAt、message

#### Scenario: 审批操作
- **WHEN** 用户确认或拒绝审批
- **THEN** 发送 `approval.confirm` 或 `approval.reject` 请求（带 `idempotencyKey`）
- **AND** 审批项从列表中移除

### Requirement: Memory Panel
基于 `memory.search`、`memory.write`。

#### Scenario: 记忆搜索
- **WHEN** 用户输入搜索词
- **THEN** 发送 `memory.search` 请求
- **AND** 显示结果列表（chunkId、fileId、section、filePath、score、content snippet）

#### Scenario: 记忆写入
- **WHEN** 用户写入记忆
- **THEN** 发送 `memory.write` 请求（带 `idempotencyKey`、`sessionId`、`content`、`scope`）
- **AND** 前端不构造任意路径，只提供 content 和 scope

### Requirement: Audit Panel
基于 `audit.tail`。

#### Scenario: 审计日志
- **WHEN** 用户查看 Audit Panel
- **THEN** 显示最近 N 条审计事件
- **AND** 敏感字段显示 `[REDACTED]`
- **AND** 默认只显示摘要，不提供任意文件读取入口

---

## 四、WS Client SDK 规范

### Requirement: 连接管理

#### Scenario: 初始连接
- **WHEN** SDK 建立 WebSocket 连接
- **THEN** 连接成功后立即发送 `connect` 请求
- **AND** 携带 `{ protocolVersion: "1.0", clientName: "web-ui" }`
- **AND** 等待 `connect_ok` 响应后才标记为就绪

#### Scenario: 断线重连
- **WHEN** WebSocket 连接断开
- **THEN** 使用指数退避重连（初始 1s，最大 30s，含 jitter）
- **AND** 不高频重连打爆本地 Gateway
- **AND** 重连后重新发送 `connect` 请求

#### Scenario: 断线恢复
- **WHEN** 重连成功后
- **THEN** 对每个活跃 session 发送 `session.getTranscript`（带 `afterSeq: lastSeq`）
- **AND** 对比 `chat.completed.payload.lastSeq` 和本地 `lastSeq`
- **AND** 如果存在间隙，发送 `audit.tail`（带 `afterSeq: lastSeq`）补齐

### Requirement: 请求/响应管理

#### Scenario: 唯一请求 ID
- **WHEN** SDK 发送任何请求
- **THEN** `id` 字段 SHALL 全局唯一
- **AND** 建议格式：`web_${method}_${timestamp}_${shortId}`

#### Scenario: Promise Map
- **WHEN** SDK 发送请求
- **THEN** 将 `id` 注册到 Promise Map
- **AND** 收到对应 `id` 的响应时 resolve/reject
- **AND** 超时后 reject 并清理

#### Scenario: 副作用幂等
- **WHEN** SDK 发送副作用方法
- **THEN** SHALL 包含 `idempotencyKey`
- **AND** 副作用方法包括：`chat.send`、`tool.call`、`memory.write`、`session.bindProject`、`approval.confirm`、`approval.reject`

### Requirement: 事件处理

#### Scenario: Event Reducer
- **WHEN** SDK 收到 server event
- **THEN** 进入 event reducer，按类型派生 UI 状态
- **AND** request/response 走 Promise Map，event 走 reducer，不混合

#### Scenario: Resync 处理
- **WHEN** 收到 `state.resync_required` 事件
- **THEN** 重新拉取 `runtime.status`、`session.get`、`session.getTranscript`、必要的 `audit.tail`
- **AND** 使用事件中的 `reason` 记录日志

#### Scenario: Delta 批处理
- **WHEN** 短时间内收到多个 `chat.delta`
- **THEN** 合并为一次 UI 更新
- **AND** 批处理间隔 30-80ms

### Requirement: 安全

#### Scenario: Token 管理
- **WHEN** SDK 存储认证 token
- **THEN** 不进入日志
- **AND** 不进入 localStorage 明文
- **AND** 优先运行时输入或安全配置注入

---

## 五、Run 状态机

### Requirement: 七状态有限状态机

前端 SHALL 实现以下 Run 状态机：

| 状态 | 触发条件 | 说明 |
|---|---|---|
| `idle` | 初始/运行结束后 | 无运行 |
| `starting` | 发送 `chat.send` | 等待 response |
| `running` | 收到 `run.started` | 运行中 |
| `streaming` | 收到 `chat.delta` | 流式输出中 |
| `completed` | 收到 `chat.completed` + `run.finished` | 完成 |
| `cancelling` | 用户点击 cancel，发送 `chat.cancel` | 取消中 |
| `cancelled` | 收到 `run.cancelled` | 已取消 |
| `failed` | 收到 `run.failed` 或 response error | 失败 |

#### Scenario: 正常流程
- **WHEN** 用户发送消息
- **THEN** 状态转换：`idle` → `starting` → `running` → `streaming` → `completed`

#### Scenario: 取消流程
- **WHEN** 用户取消运行
- **THEN** 状态转换：`streaming` → `cancelling` → `cancelled`

#### Scenario: 失败流程
- **WHEN** 运行失败
- **THEN** 状态转换：`starting`/`running`/`streaming` → `failed`

---

## 六、流式渲染规范

### Requirement: Delta 处理

#### Scenario: 实时显示
- **WHEN** 收到 `chat.delta` 事件
- **THEN** 用于实时追加显示文本
- **AND** 不作为最终可信文本源

#### Scenario: 最终文本
- **WHEN** 收到 `chat.completed` 事件
- **THEN** 使用 `chat.completed.payload.text` 作为最终文本
- **AND** 覆盖 delta 拼接的文本

#### Scenario: 断线恢复
- **WHEN** delta 丢失或断线
- **THEN** 前端仍能用 `chat.completed` 文本恢复

#### Scenario: UI 批处理
- **WHEN** 短时间内收到多个 delta
- **AND** 使用 requestAnimationFrame 或 30-80ms setTimeout 合并更新

---

## 七、安全交互规范

### Requirement: 前端安全边界

#### Scenario: Origin 白名单
- **WHEN** Browser 端建立 WebSocket 连接
- **THEN** 浏览器 Origin SHALL 在 `GATEWAY_WS_ALLOWED_ORIGINS` 中

#### Scenario: Memory 写入限制
- **WHEN** 前端发送 `memory.write`
- **THEN** 只提供 `content` 和 `scope`
- **AND** 不构造任意文件路径

#### Tool 调用展示
- **WHEN** 显示 tool 调用
- **THEN** 明确展示 toolName、input preview、sessionId、风险状态

#### Scenario: Tool 拒绝处理
- **WHEN** 收到 `tool.denied`
- **THEN** 不自动重试
- **AND** 提示需要权限、绑定项目或 approval

#### Scenario: Audit 脱敏
- **WHEN** 显示审计数据
- **THEN** 只显示 redacted 数据
- **AND** 敏感字段显示 `[REDACTED]`
- **AND** 不提供任意文件读取入口

---

## 八、视觉设计规范

### Requirement: 控制台风格

#### Scenario: 整体风格
- **WHEN** 用户查看 Web UI
- **THEN** 风格为本地控制台、清晰、偏工程化
- **AND** 不做普通 SaaS 聊天皮肤

#### Scenario: 配色
- **WHEN** 渲染界面
- **THEN** 深色控制台底色 + 高对比状态色
- **AND** 避免大面积紫色默认风

#### Scenario: 状态色
- **WHEN** 显示状态
- **THEN** running 蓝色，success 绿色，warning 琥珀色，denied 红色，cancelled 灰色

#### Scenario: Timeline
- **WHEN** 显示事件时间线
- **THEN** 纵向事件流，按 seq 排序
- **AND** 支持按 runId/sessionId 过滤

#### Scenario: Tool payload
- **WHEN** 显示 Tool 调用详情
- **AND** 默认折叠
- **AND** 提供 copy JSON、查看摘要、查看 artifact path

#### Scenario: Audit
- **WHEN** 显示审计日志
- **THEN** 默认只显示摘要
- **AND** 敏感字段永远显示 `[REDACTED]`

---

## 九、技术架构

### Requirement: 状态层拆分

前端状态 SHALL 拆分为以下 store：

| Store | 职责 |
|---|---|
| `connectionStore` | WS 连接状态、重连计数、认证状态 |
| `sessionStore` | Session 列表、当前 session、lastSeq、transcriptCache |
| `runStore` | Run 状态机、activeRunIds、当前 run 的 delta 缓冲 |
| `eventStore` | 事件时间线、seq 索引、按 runId/sessionId 过滤 |
| `approvalStore` | 待审批列表、操作状态 |

### Requirement: WS Client 封装

#### Scenario: SDK 独立封装
- **WHEN** 前端使用 WebSocket
- **THEN** WS client SHALL 封装为独立 SDK（`packages/ws-client`）
- **AND** 不把 WebSocket 逻辑散落在组件中
- **AND** VS Code Client 后续可复用同一套 SDK

### Requirement: 事件处理架构

#### Scenario: 事件分发
- **WHEN** 收到 server event
- **THEN** 先进入 event reducer
- **AND** 再派生 UI 状态
- **AND** request/response 走 Promise Map，event 走 reducer

### Requirement: 大 Payload 处理

#### Scenario: Lazy Render
- **WHEN** 显示大 payload（如 tool output）
- **THEN** 使用 lazy render
- **AND** JSON viewer 不一次性展开

---

## 十、MVP 范围

### Requirement: MVP 功能清单

前端 MVP SHALL 包含以下功能：

1. 连接 WS + `connect`
2. `session.list` / `session.create` / `session.get`
3. `chat.send` + `chat.delta` + `chat.completed` + `chat.cancel`
4. `tool.list` + tool timeline（`tool.started` / `tool.finished` / `tool.denied` / `tool.failed`）
5. `approval.list` / `approval.confirm` / `approval.reject`
6. `memory.search` / `memory.write`
7. `runtime.status` + `ws.metrics`
8. `audit.tail` 基础视图
9. reconnect resume + `state.resync_required` 处理

---

## 后端限制（前端需感知）

1. **ReplayBuffer 是内存级**，不是持久化事件日志。重启后丢失。
2. **`session.rename` 只支持 current session**，需要先 `session.switch`。
3. **Provider streaming 取决于 model provider**，不是所有 provider 都支持 delta。
4. **慢客户端可能丢弃低优先级 `chat.delta`**，前端必须能从 `chat.completed` 重建最终文本。
5. **WS 是本地受控 Gateway**，不建议直接暴露公网。
6. **`approval.list` 包含已过期项**，前端应检查 `expiresAt`。
7. **`tool.list` 返回的 dynamic tools 是运行时快照**，可能在 MCP 重连后变化。
8. **`memory.search` score 是 provider 相关的**，不同 provider 的分数不直接可比。
9. **`audit.tail` 敏感字段已被服务端 redact**，前端无法获取原始值。
10. **`session.getTranscript` 重启后 replay 丢失**，仅补发服务端当前启动后的事件。
