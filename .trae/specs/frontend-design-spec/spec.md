# Frontend Design Spec Optimized（前端设计规范 · 优化版）

## 0. 设计基线

本规范面向 `agent-rebuild` 当前真实后端。前端不是普通聊天页，而是 **Local Agent Control Console**：用于管理 Session、Run、Tool Timeline、Approval、Memory、Audit 与 Gateway 状态。

当前后端已提供 WebSocket Gateway：

- 启动脚本：`npm run gateway:ws`
- WS 入口：`ws://127.0.0.1:8787/v1/ws`
- 协议来源：`packages/gateway/ws/protocol.ts`
- 参数校验：`packages/gateway/ws/schemas.ts`
- 请求路由：`packages/gateway/ws/router.ts`
- WS Server：`packages/gateway/ws/wsServer.ts`

前端实现必须以真实后端协议为准，不自行发明 `connect_ok`、`eventId`、`afterSeq` 等未实现字段。

---

## 1. 产品定位

### Requirement: Local Agent Control Console

前端 SHALL 作为本地 Agent Gateway 的控制台，而不是普通 SaaS Chat UI。

#### Scenario: 多会话管理

- WHEN 用户打开 Web UI
- THEN 左侧显示 Session 列表
- AND 每个 Session 显示 name、messageCount、updatedAt、projectBound / permission 状态
- AND 用户可以创建 Session、查看详情、绑定项目目录

#### Scenario: 显式 Session 上下文

- WHEN 用户执行 chat、tool、memory、approval 操作
- THEN 请求 SHALL 显式携带 `sessionId`
- AND 前端不依赖隐式 current session，除非后端方法明确支持缺省 current session

#### Scenario: 一等运行状态

- WHEN 前端管理运行过程
- THEN `sessionId`、`runId`、`seq`、`idempotencyKey` SHALL 作为一等状态
- AND 每个 session 保存 `lastSeq`、`activeRunIds`、`transcriptCache`

---

## 2. 信息架构

### Requirement: 四区域布局

桌面端采用四区域布局：

1. 左侧：Session Workspace
2. 中间：Run Console / Chat 主视图
3. 右侧：Tool Timeline / Event Timeline
4. 顶部：Status Bar

#### Status Bar SHOULD 显示

- WS 连接状态
- 当前模型
- sandbox mode
- tool count
- active runs
- reconnect 状态
- lastSeq / resync 状态

### Requirement: 移动端适配

- Session + Chat 优先展示
- Timeline、Audit、Approval 进入 Drawer / Sheet
- 大 payload 默认折叠，避免移动端卡顿

---

## 3. WS 协议约束

### Requirement: 统一请求/响应格式

客户端发送：

```ts
{
  type: "req",
  id: string,
  method: GatewayWsMethod,
  params?: unknown,
  idempotencyKey?: string,
  clientSeq?: number
}
```

服务端返回：

```ts
{
  type: "res",
  id: string,
  ok: boolean,
  payload?: unknown,
  error?: { code: GatewayWsErrorCode, message: string, details?: unknown }
}
```

服务端事件：

```ts
{
  type: "event",
  seq: number,
  event: GatewayWsEvent,
  runId?: string,
  sessionId?: string,
  payload?: unknown,
  createdAt: string
}
```

### Requirement: connect 握手

#### Scenario: 初始连接

- WHEN SDK 建立 WebSocket 连接
- THEN 立即发送 `connect` 请求
- AND params 包含 `{ protocolVersion: "1.0", clientName: "web-ui" }`
- AND 只有收到 `connect` response 且 `ok: true` 后，SDK 才进入 ready 状态
- AND `connected` event 只作为诊断事件，不作为唯一 ready 判断

> 注意：真实后端没有 `connect_ok` 消息类型，禁止前端等待不存在的 `connect_ok`。

### Requirement: 认证与 Origin

- Browser 端连接必须满足 `GATEWAY_WS_ALLOWED_ORIGINS`
- 如果后端配置 `GATEWAY_WS_TOKEN`，前端可通过 query token 或 Authorization Bearer 传递
- 认证失败 SHALL 不进入无限重连循环
- Token 不进入日志、不进入 localStorage 明文

---

## 4. WS Client SDK 规范

### Requirement: 新增 `packages/ws-client`

SDK SHALL 封装所有 WebSocket 细节，UI 组件不得直接操作原生 WebSocket。

#### 包结构

```txt
packages/ws-client/
  package.json
  tsconfig.json
  src/
    index.ts
    types.ts
    methodMap.ts
    connectionManager.ts
    requestManager.ts
    eventDispatcher.ts
    resumeManager.ts
    gatewayClient.ts
```

### Requirement: 类型来源

- `GatewayWsMethod`、`GatewayWsEvent`、`WsRequest`、`WsResponse`、`WsEvent` SHALL 从 `packages/gateway/ws/protocol.ts` 导入
- 前端可以新增 `GatewayMethodParams`、`GatewayMethodResult`、`GatewayEventPayload` 映射类型
- 前端不得重新定义协议字符串枚举

### Requirement: RequestManager

- 请求 ID 全局唯一，建议：`web_${method}_${timestamp}_${shortId}`
- 每个请求进入 Promise Map
- 收到匹配 `id` 的 response 后 resolve/reject
- 超时后 reject 并清理
- 连接断开时 reject 所有 pending 请求
- request/response 与 event 处理分离

### Requirement: 幂等 key

以下副作用方法 SHALL 自动注入 `idempotencyKey`：

- `chat.send`
- `tool.call`
- `memory.write`
- `session.create`
- `session.bindProject`
- `approval.confirm`
- `approval.reject`

`chat.cancel` 可选注入，但当前后端只要求 `runId`。

### Requirement: EventDispatcher

- event 进入 reducer，不进入 Promise Map
- 支持类型安全监听：`on("chat.delta", handler)`
- 支持 `chat.delta` 批处理，默认 50ms，可配置 30-80ms
- 支持基于 `(sessionId, seq)` 的去重
- 支持 `state.resync_required` 自动触发 full resync

---

## 5. 断线恢复规范

### Requirement: 基于真实后端 resume

当前后端恢复路径是 `connect.params.resume`，不是 `session.getTranscript(afterSeq)`。

#### Scenario: 正常重连

- WHEN WS 断开后重连
- THEN SDK 对每个活跃 session 发送 connect：
  ```ts
  {
    protocolVersion: "1.0",
    clientName: "web-ui",
    resume: { sessionId, lastSeq }
  }
  ```
- AND `lastSeq` 来自前端最后处理过的 `WsEvent.seq`
- AND replay 成功时，后端会补发 `seq > lastSeq` 的会话事件

#### Scenario: replay 不可用

- WHEN 收到 `state.resync_required`
- THEN SDK 执行 full resync：
  - `runtime.status`
  - `session.get`
  - `session.getTranscript`
  - `approval.list`
  - `audit.tail`
- AND UI 标记本 session 曾发生过状态重同步

#### Scenario: 去重

- WHEN 收到 replay 事件或实时事件
- THEN 基于 `${sessionId}:${seq}` 去重
- AND 不依赖当前协议不存在的 `eventId`

---

## 6. 核心页面

### 6.1 Gateway Dashboard

基于 `runtime.status`。

当前后端返回字段主要包括：

- `model`
- `debug`
- `sandboxMode`
- `toolCount`
- `sessionCount`
- `currentSessionId`
- `metrics`
- `wsMetrics`

UI 可以派生展示：

- model / sandbox mode
- tool count
- session count
- request metrics
- WS metrics
- circuit / error rate / latency summary

### 6.2 Session Workspace

基于：

- `session.list`
- `session.create`
- `session.get`
- `session.rename`
- `session.bindProject`
- `session.getTranscript`

注意：

- `session.rename` 当前后端 v1 只支持 current session
- `session.bindProject` 是副作用方法，必须带 `idempotencyKey`
- `session.getTranscript` 当前只要求 `sessionId`，不支持 `afterSeq`

### 6.3 Run Console

基于：

- `chat.send`
- `chat.cancel`
- `chat.delta`
- `chat.completed`
- `run.started`
- `run.finished`
- `run.failed`
- `run.cancelled`

#### 发送消息

- `chat.send` params：`{ sessionId, input }`
- 成功 response 只表示 run 创建成功
- 后续进度通过 event 推送

#### 取消运行

- `chat.cancel` params：`{ runId }`
- 取消不显示为错误
- 若后端返回 CONFLICT，UI 显示“任务已结束或不可取消”

#### 流式渲染

- `chat.delta` 只用于实时显示
- `chat.completed.payload.text` 是最终可信文本
- completed 到达后覆盖 delta 拼接文本

### 6.4 Tool Timeline

基于：

- `tool.started`
- `tool.finished`
- `tool.denied`
- `tool.failed`
- `tool.list`
- `tool.call`

要求：

- 事件按 `seq` 排序
- 支持按 sessionId / runId / toolName / status 过滤
- payload 默认折叠
- 大 JSON lazy render
- tool denied 不自动重试

### 6.5 Approval Center

基于：

- `approval.list`
- `approval.confirm`
- `approval.reject`
- `approval.required`
- `approval.confirmed`
- `approval.rejected`

要求：

- 显示 token、toolName、input preview、expiresAt、message
- 前端检查 expiresAt，过期项置灰
- confirm/reject 必须带 `idempotencyKey`

### 6.6 Memory Panel

基于：

- `memory.search`
- `memory.write`

要求：

- `memory.search` 输入 query
- `memory.write` 只允许 content / scope / sessionId
- 前端不得构造任意文件路径
- 写入成功后显示 scope、filePath，但 filePath 只读展示

### 6.7 Audit Panel

基于：

- `audit.tail`
- `audit.append`

要求：

- 默认只显示摘要
- 敏感字段显示 `[REDACTED]`
- 不提供任意文件读取入口
- 支持按 type / sessionId / runId / toolName 过滤

---

## 7. Run 状态机

### Requirement: 八状态有限状态机

| 状态 | 触发条件 | 说明 |
|---|---|---|
| `idle` | 初始/运行结束后 | 无运行 |
| `starting` | 发送 `chat.send` | 等待 response |
| `running` | 收到 `run.started` | 运行中 |
| `streaming` | 收到 `chat.delta` | 流式输出中 |
| `completed` | 收到 `chat.completed` 或 `run.finished` | 完成 |
| `cancelling` | 用户点击 cancel | 取消中 |
| `cancelled` | 收到 `run.cancelled` | 已取消 |
| `failed` | 收到 `run.failed` 或 response error | 失败 |

### 状态不可逆保护

以下终态不可被后续普通事件覆盖：

- `completed`
- `cancelled`
- `failed`

如果终态后又收到迟到的 `chat.delta`，只记录到 timeline，不改变主状态。

---

## 8. 状态层拆分

| Store | 职责 |
|---|---|
| `connectionStore` | WS 状态、重连计数、认证状态、ready 状态 |
| `sessionStore` | Session 列表、当前 session、lastSeq、transcriptCache |
| `runStore` | Run 状态机、activeRunIds、delta buffer、final text |
| `eventStore` | 事件时间线、seq index、过滤、去重 |
| `approvalStore` | 待审批项、confirm/reject 操作状态 |
| `memoryStore` | memory search/write 状态 |
| `auditStore` | audit tail、audit append、redacted 展示 |

---

## 9. 视觉设计规范

### 风格

- 深色控制台主题
- 工程化、清晰、偏本地 IDE / DevTool 风格
- 避免普通 SaaS 紫色聊天皮肤

### 状态色

- running：蓝
- success：绿
- warning：琥珀
- denied / failed：红
- cancelled：灰
- resync：紫或青色提示，但不大面积使用

### 字体

- 普通 UI：system sans
- payload / code / logs：monospace

### Timeline

- 纵向事件流
- 按 seq 排序
- 支持过滤
- payload 默认折叠
- 可复制 JSON
- 大 payload lazy render

---

## 10. MVP 范围

MVP SHALL 包含：

1. 连接真实 WS：`ws://127.0.0.1:8787/v1/ws`
2. `connect` 握手
3. `runtime.status`
4. `session.list/create/get/getTranscript`
5. `chat.send`、`chat.cancel`
6. `chat.delta`、`chat.completed`、`run.*`
7. `tool.list` + Tool Timeline
8. `approval.list/confirm/reject`
9. `memory.search/write`
10. `audit.tail`
11. reconnect + resume + `state.resync_required`
12. TypeScript 零错误

---

## 11. 后端限制

前端必须感知以下限制：

1. ReplayBuffer 是内存级，重启后丢失。
2. `session.getTranscript` 当前不支持 `afterSeq`。
3. `audit.tail` 当前不支持 `afterSeq`。
4. `chat.completed.payload` 当前不包含 `lastSeq`。
5. 当前事件没有 `eventId`，去重应使用 `(sessionId, seq)`。
6. `session.rename` v1 只支持 current session。
7. 慢客户端可能丢弃低优先级 `chat.delta`。
8. 最终文本必须以 `chat.completed.payload.text` 为准。
9. `approval.list` 可能包含过期项，前端需要检查 expiresAt。
10. WS Gateway 是本地受控入口，不建议直接暴露公网。
