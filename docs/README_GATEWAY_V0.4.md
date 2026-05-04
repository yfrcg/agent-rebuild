# Agent Gateway v0.4

## 1. 概览

Gateway 当前已完成 v0.1 ~ v0.4 的最小可用闭环：

- v0.1：Gateway 主链路 + memory.search + model provider + audit + resilience + detect
- v0.2：Session Management（多会话元数据与切换）
- v0.3：内部 Tool Registry（注册/列出/调用）
- v0.4：Tool Call Protocol（标准 tool call request/record/status/audit）

本版本仍坚持：

- 不接 MCP
- 不做多 Agent
- 不做 WebSocket
- 不做前端 UI
- 不改 memory 系统架构与索引/embedding/hybrid search 设计

---

## 2. 当前架构链路

### 2.1 普通聊天主链路（保持稳定）

```txt
CLI input
→ parse command
→ (非内建命令) Gateway.handle(request)
→ memory.search (Gateway memory adapter)
→ contextBuilder
→ modelProvider
→ auditLogger
→ Gateway response
→ transcript record（按 active session）
```

### 2.2 内建工具调用链路（v0.4）

```txt
:tool <name> <json>
→ parse command
→ createGatewayToolCallRequest()
→ ToolCallExecutor.execute()
→ ToolRegistry.invoke()
→ Tool output (ok true/false)
→ ToolCallRecord (pending→running→succeeded/failed)
→ tool call audit event
```

---

## 3. 目录结构（Gateway 相关）

```txt
apps/gateway/src/
  main.ts

packages/gateway/
  gateway.ts
  types.ts
  requestHandler.ts
  contextBuilder.ts
  memoryAdapter.ts
  replHelp.ts
  replCommandHandlers.ts
  commandParser.ts

  sessionTypes.ts
  sessionStore.ts
  sessionManager.ts

  toolTypes.ts
  toolRegistry.ts
  builtinTools.ts

  toolCallTypes.ts
  toolCallFactory.ts
  toolCallExecutor.ts
  toolCallPrinter.ts

packages/model/
  mockProvider.ts
  deepseekProvider.ts
  types.ts

packages/audit/
  auditLogger.ts
  types.ts

scripts/
  smoke-gateway.ts
  smoke-gateway-memory-failure.ts
  smoke-gateway-model-failure.ts
  smoke-gateway-all.ts
  system-detect.ts
```

---

## 4. 运行方式

类型检查：

```bash
npm run typecheck
```

构建：

```bash
npm run build
```

启动 Gateway CLI：

```bash
npm run gateway
```

全量准入检查：

```bash
npm run gateway:check
```

---

## 5. 环境变量

### 5.1 Gateway 运行配置

```env
GATEWAY_MODEL=mock
GATEWAY_MEMORY_TOP_K=5
GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
GATEWAY_DEBUG=true
```

### 5.2 DeepSeekProvider（真实模型）

```env
GATEWAY_MODEL=deepseek
DEEPSEEK_API_KEY=xxx
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MAX_TOKENS=1024
DEEPSEEK_TEMPERATURE=0.7
DEEPSEEK_TIMEOUT_MS=30000
```

### 5.3 system-detect（脚本内部注入）

- `scripts/system-detect.ts` 会在检测期间注入 embedding/mock API 相关变量。
- 当前 `performance.errorRate` 语义已校正，代表负载压测中的真实响应错误率。

---

## 6. REPL 命令

### 6.1 通用命令

- `help`
- `exit`
- `flush`
- `recover`
- `记住：<内容>`
- `查记忆 <关键词>`
- `读文件 <相对路径>`

### 6.2 Session 命令（v0.2）

- `:session`
- `:session current`
- `:session list`
- `:session new [name]`
- `:session switch <sessionId>`
- `:session rename <name>`

### 6.3 Tool 命令（v0.3/v0.4）

- `:tools`：列出已注册工具
- `:tool <name> <json>`：通过 Tool Call Protocol 手动调用工具

示例：

```txt
:tool memory.search {"query":"Gateway v0.4","topK":5}
```

---

## 7. Session Management 说明

- session metadata 文件：
  - `logs/sessions/sessions.json`
- transcript 文件：
  - `workspace/sessions/<sessionId>.jsonl`
- 主循环按 active sessionId 记录 user/assistant/tool 轨迹
- SessionManager 负责：
  - 初始化默认会话
  - 当前会话切换
  - 会话重命名
  - 消息计数维护

---

## 8. Tool Registry 说明（v0.3）

### 8.1 能力

- `register(tool)`
- `has(name)`
- `list()`
- `get(name)`
- `invoke(name, input, context?)`

### 8.2 约束

- 重复注册会抛清晰错误
- 工具不存在返回 `ok:false`
- 工具内部异常包装为 `ok:false`
- 工具异常不会打崩 Gateway 进程

### 8.3 当前内置工具

- `memory.search`
  - 输入：
    - `query: string`（required）
    - `topK?: number`
  - 输出：
    - `ok: true`
    - `content: MemorySearchResult[]`
    - `metadata.count`

---

## 9. Tool Call Protocol 说明（v0.4）

### 9.1 核心对象

- `GatewayToolCallRequest`
  - `id/toolName/input/sessionId/requestId/createdAt`
- `GatewayToolCallRecord`
  - `status: pending|running|succeeded|failed`
  - `startedAt/completedAt/durationMs`
  - `output/error`

### 9.2 执行流程

```txt
create request
→ execute (pending)
→ running
→ registry.invoke
→ succeeded / failed
→ complete timestamps + duration
→ write audit (best effort)
```

### 9.3 CLI 输出

`:tool` 现在输出 ToolCallRecord 核心字段：

- `id`
- `toolName`
- `status`
- `durationMs`
- `error`
- `output.metadata`
- `output.content`

非法 JSON 会友好提示 parse failed，不崩溃。

---

## 10. Audit Log 说明

默认日志：

- `logs/gateway-audit.jsonl`

当前典型事件（包含但不限于）：

- `gateway.request.received`
- `memory.search.completed`
- `context.built`
- `model.generate.completed`
- `gateway.response.completed`
- `gateway.rate_limited`
- `gateway.circuit.open`
- `gateway.tool_call.completed`
- `gateway.tool_call.failed`

原则：

- 审计写入失败不影响主流程与 tool call 执行结果

---

## 11. gateway:check / system-detect

`npm run gateway:check` 包含：

```txt
typecheck
→ build
→ gateway smoke(all)
→ system-detect
```

`system-detect` 覆盖：

- Gateway unit/resilience
- API adapter（DeepSeek/embedding）
- memory reliability
- full-chain smoke
- load performance

输出：

- `logs/system-detection-report.json`

---

## 12. 当前明确未做能力

以下能力仍明确不在当前版本范围：

- MCP Adapter（尚未接入）
- 多 Agent 编排
- WebSocket 协议层
- 前端 UI
- 插件市场
- Docker Sandbox
- 复杂权限/RBAC
- 模型自动工具选择
- 自动工具调用循环
- Planner/任务规划器

---

## 13. v0.5（MCP Adapter）边界建议

v0.5 只建议做“适配层”而非完整智能体：

- 把 MCP tool 映射到现有 Tool Registry
- 复用 v0.4 Tool Call Protocol 的 request/record/status/audit
- 保持 `:tool` 手动调用路径可继续工作
- 不引入自动工具循环
- 不引入多 Agent
- 不引入 WebSocket/UI
- 不改 memory 架构
- 不重写 `gateway.ts` 主链路

可交付目标建议：

- MCP 工具可被注册为内部工具（与 builtin tools 并存）
- 调用结果统一产出 ToolCallRecord
- 失败行为与审计语义与 v0.4 一致
