# Agent Gateway v0.1

## 1. 当前目标

Gateway v0.1 的目标不是完整多 Agent 平台，而是先跑通最小链路：

```txt
User Input
→ Gateway
→ memory.search
→ context builder
→ model provider
→ audit logger
→ response
```

当前阶段重点：

- 统一请求入口
- 调用已有 memory hybridSearch
- 构建 prompt context
- 支持 MockModelProvider
- 支持 MiniMaxProvider
- 写入 audit log
- 保留原来的本地记忆命令

暂时不做：

- MCP Client
- 多 Agent
- 前端 UI
- WebSocket
- Docker Sandbox
- RBAC
- 插件市场
- 复杂工具权限系统

---

## 2. 当前目录结构

```txt
apps/gateway/src/main.ts

packages/gateway/
  types.ts
  requestHandler.ts
  contextBuilder.ts
  gateway.ts
  memoryAdapter.ts
  env.ts
  config.ts

packages/model/
  types.ts
  mockProvider.ts
  minimaxProvider.ts

packages/audit/
  types.ts
  auditLogger.ts

scripts/
  smoke-gateway.ts
  smoke-gateway-memory-failure.ts
  smoke-gateway-model-failure.ts
  smoke-gateway-all.ts
```

---

## 3. 核心模块说明

### 3.1 apps/gateway/src/main.ts

CLI 入口。

负责：

- 启动 REPL
- 读取 `.env`
- 加载 bootstrap context
- 初始化 Gateway
- 保留原有记忆命令
- 把普通用户输入交给 Gateway 处理

普通输入会进入 Gateway：

```txt
raw input
→ createGatewayRequest
→ gateway.handle
→ memory search
→ context builder
→ model provider
→ audit logger
→ response
```

---

### 3.2 packages/gateway/types.ts

定义 Gateway 的核心类型：

- `ChatMessage`
- `GatewayRequest`
- `GatewayResponse`
- `MemorySearchResult`
- `GatewayDebugInfo`

其中 `GatewayResponse` 是最终返回结构：

```ts
export interface GatewayResponse {
  id: string;
  text: string;
  memoryUsed: MemorySearchResult[];
  error?: string;
  debug?: GatewayDebugInfo;
  createdAt: string;
}
```

---

### 3.3 packages/gateway/requestHandler.ts

负责把外部输入转换为 Gateway 内部请求：

```txt
raw input string
→ GatewayRequest
```

主要作用：

- 生成 request id
- trim 用户输入
- 记录 createdAt

---

### 3.4 packages/gateway/gateway.ts

Gateway 主流程。

负责串联：

```txt
GatewayRequest
→ memorySearch
→ buildContext
→ modelProvider.generate
→ auditLogger.log
→ GatewayResponse
```

设计原则：

- Gateway 是统一入口和调度中心
- Memory 是内部工具
- Model Provider 可替换
- Audit Logger 是旁路记录
- memory 失败时使用空记忆继续
- model 失败时返回带 error 的 GatewayResponse
- audit 失败不能影响主流程

---

### 3.5 packages/gateway/memoryAdapter.ts

Gateway 和旧 memory 系统之间的适配层。

当前内部调用：

```ts
hybridSearch(query, topK)
```

然后转换成 Gateway 统一格式：

```ts
MemorySearchResult[]
```

这样 Gateway 不直接依赖 memory 系统的内部结构。

---

### 3.6 packages/gateway/contextBuilder.ts

把：

```txt
用户输入
+
记忆检索结果
```

转换成：

```ts
ChatMessage[]
```

用于传给模型 provider。

---

### 3.7 packages/gateway/env.ts

负责读取项目根目录的 `.env` 文件。

当前支持最小格式：

```env
KEY=value
KEY="value"
KEY='value'
```

优先级：

```txt
命令行环境变量 > .env 文件
```

---

### 3.8 packages/gateway/config.ts

负责集中读取 Gateway 运行配置。

当前支持：

```env
GATEWAY_MODEL=mock
GATEWAY_MEMORY_TOP_K=5
GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
GATEWAY_DEBUG=true
```

返回结构：

```ts
export interface GatewayRuntimeConfig {
  model: GatewayModelName;
  memoryTopK: number;
  auditLogPath: string;
  debug: boolean;
}
```

---

### 3.9 packages/model/types.ts

定义统一模型接口：

```ts
export interface ModelProvider {
  name: string;
  generate(messages: ChatMessage[]): Promise<ModelResponse>;
}
```

所有模型都应该实现：

```txt
ChatMessage[]
→ ModelResponse
```

---

### 3.10 packages/model/mockProvider.ts

假的模型 provider。

用于本地跑通链路，不调用真实 API。

作用：

- 验证 Gateway 主流程
- 验证 contextBuilder 输出
- 验证 audit log
- 避免一开始就依赖真实模型 API

---

### 3.11 packages/model/minimaxProvider.ts

真实 MiniMax 模型 provider。

通过 OpenAI-compatible chat completions API 调用 MiniMax。

支持配置：

```env
MINIMAX_API_KEY=你的 MiniMax Key
MINIMAX_MODEL=M2
MINIMAX_BASE_URL=https://api.minimax.io/v1
MINIMAX_MAX_TOKENS=1024
MINIMAX_TEMPERATURE=0.7
MINIMAX_TIMEOUT_MS=30000
```

如果 MiniMax 调用失败，错误会被 Gateway 捕获，并返回带 `error` 字段的 `GatewayResponse`。

---

### 3.12 packages/audit/auditLogger.ts

审计日志记录器。

默认写入：

```txt
logs/gateway-audit.jsonl
```

日志格式是 JSONL，一行一个事件。

设计原则：

```txt
Audit Logger 是旁路记录
审计失败不能影响主流程
```

---

## 4. 环境变量配置

项目根目录创建 `.env`。

### 4.1 使用 Mock 模型

```env
GATEWAY_MODEL=mock
GATEWAY_MEMORY_TOP_K=5
GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
GATEWAY_DEBUG=true
```

### 4.2 使用 MiniMax 模型

```env
GATEWAY_MODEL=minimax
GATEWAY_MEMORY_TOP_K=5
GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
GATEWAY_DEBUG=true

MINIMAX_API_KEY=你的 MiniMax Key
MINIMAX_MODEL=M2
MINIMAX_BASE_URL=https://api.minimax.io/v1
MINIMAX_MAX_TOKENS=1024
MINIMAX_TEMPERATURE=0.7
MINIMAX_TIMEOUT_MS=30000
```

---

## 5. 运行方式

类型检查：

```bash
npm run typecheck
```

启动 Gateway REPL：

```bash
npm run gateway
```

或者：

```bash
npx tsx apps/gateway/src/main.ts
```

---

## 6. 当前支持的 REPL 命令

### 6.1 记住内容

```txt
记住：<内容>
```

作用：

- 自动分类为 long-term 或 daily memory
- 写入 `MEMORY.md` 或 daily memory
- 更新 memory index

---

### 6.2 查记忆

```txt
查记忆 <关键词>
```

作用：

- 直接调用 `hybridSearch`
- 打印检索结果
- 不进入 Gateway 模型回答链路

---

### 6.3 读文件

```txt
读文件 <相对路径>
```

作用：

- 调用 `memoryGet`
- 打印文件内容

---

### 6.4 flush

```txt
flush
```

作用：

- 执行 `preCompactionFlush`
- 更新 `MEMORY.md` 索引

---

### 6.5 recover

```txt
recover
```

作用：

- 执行 `postCompactionRecovery`
- 重新加载 bootstrap context

---

### 6.6 help

```txt
help
```

作用：

- 打印当前 REPL 命令说明

---

### 6.7 exit

```txt
exit
```

作用：

- 退出 REPL
- 写入 transcript

---

### 6.8 普通输入

例如：

```txt
我现在的 Gateway 架构是什么？
```

作用：

- 进入 Gateway v0.1 主流程
- 检索 memory
- 构建上下文
- 调用当前模型 provider
- 写 audit log
- 返回回答

---

## 7. Audit Log

默认日志位置：

```txt
logs/gateway-audit.jsonl
```

典型事件：

```txt
gateway.request.received
memory.search.completed
context.built
model.generate.completed
gateway.response.completed
gateway.error
```

每一行是一个 JSON：

```json
{"id":"...","requestId":"...","type":"gateway.request.received","message":"...","createdAt":"...","data":{}}
```

---

## 8. Debug 信息

如果 `.env` 中开启：

```env
GATEWAY_DEBUG=true
```

普通输入后，GatewayResponse 会带上：

```ts
debug: {
  modelProvider: string;
  memoryCount: number;
  durationMs: number;
  hasError: boolean;
}
```

控制台会打印：

```txt
[gateway debug]
modelProvider: mock
memoryCount: 5
durationMs: 32
hasError: false
```

如果关闭：

```env
GATEWAY_DEBUG=false
```

GatewayResponse 不会返回 `debug` 字段。

---

## 9. Smoke Test

Gateway v0.1 当前提供了 3 个 smoke test，用来验证最小链路和异常兜底逻辑。

### 9.1 正常主链路测试

```bash
npm run gateway:smoke
```

验证链路：

```txt
GatewayRequest
→ memorySearch
→ contextBuilder
→ MockModelProvider
→ FileAuditLogger
→ GatewayResponse
```

通过标准：

- Gateway 能正常返回 response
- `response.text` 非空
- `memoryUsed` 有结果
- `debug.modelProvider` 为 `mock`
- `debug.hasError` 为 `false`

---

### 9.2 Memory 失败兜底测试

```bash
npm run gateway:smoke:memory-failure
```

验证链路：

```txt
memorySearch 抛错
→ Gateway 捕获错误
→ 使用空 memory context
→ 模型继续生成
→ 返回 GatewayResponse
```

通过标准：

- 程序不崩溃
- `memoryUsed` 为空数组
- `debug.memoryCount` 为 `0`
- `debug.hasError` 为 `true`
- `response.text` 仍然非空

---

### 9.3 Model 失败兜底测试

```bash
npm run gateway:smoke:model-failure
```

验证链路：

```txt
ModelProvider.generate 抛错
→ Gateway 捕获错误
→ 返回带 error 字段的 GatewayResponse
→ 程序不崩溃
```

通过标准：

- `response.error` 存在
- `response.memoryUsed` 保留 memory 结果
- `debug.modelProvider` 为 `failing-model`
- `debug.hasError` 为 `true`

---

### 9.4 一次性运行全部 smoke test

```bash
npm run gateway:smoke:all
```

这个命令会依次运行：

```bash
npm run gateway:smoke
npm run gateway:smoke:memory-failure
npm run gateway:smoke:model-failure
```

如果全部通过，说明 Gateway v0.1 当前最核心的三条链路都是健康的：

```txt
正常主链路 OK
memory 失败兜底 OK
model 失败兜底 OK
```

建议每次修改下面这些文件后都运行一次：

```txt
packages/gateway/gateway.ts
packages/gateway/contextBuilder.ts
packages/gateway/memoryAdapter.ts
packages/model/mockProvider.ts
packages/model/minimaxProvider.ts
packages/audit/auditLogger.ts
```

推荐验证顺序：

```bash
npm run typecheck
npm run gateway:smoke:all
```

---

## 10. 当前设计边界

Gateway v0.1 只负责把最小链路跑通。

当前不处理：

- 多 Agent 调度
- MCP 工具调用
- WebSocket 协议
- 前端 UI
- 工具权限系统
- 长任务队列
- 插件市场
- Docker Sandbox
- RBAC
- 审计查询 UI

这些应该放到 Gateway v0.2 或 v0.3。

---

## 11. 当前已完成

- `GatewayRequest` / `GatewayResponse` 类型
- `ModelProvider` 接口
- `MockModelProvider`
- `MiniMaxProvider`
- `ContextBuilder`
- `FileAuditLogger`
- `MemoryAdapter`
- `.env` loader
- Runtime config
- CLI REPL 接入
- Debug 信息开关
- 正常链路 smoke test
- memory 失败兜底 smoke test
- model 失败兜底 smoke test
- 统一 smoke test 调度脚本

---

## 12. 下一阶段计划

### 12.1 v0.1 后续可以继续完善

1. 把 `main.ts` 里的命令处理拆成 `commandHandler`
2. 给 audit log 增加 request duration
3. 给 audit log 增加更统一的 event data schema
4. 给 MiniMaxProvider 增加更友好的错误提示
5. 给 MiniMaxProvider 增加 retry 机制
6. 给 MemoryAdapter 增加空 query 保护
7. 给 ContextBuilder 增加最大上下文长度控制
8. 给 README 增加架构图

---

### 12.2 v0.2 以后再做

1. MCP Client
2. 多 Agent
3. WebSocket
4. 工具权限策略
5. 审计查询
6. UI
7. 插件机制
8. Docker Sandbox
9. RBAC
10. 长任务队列

---

## 13. 开发原则

Gateway v0.1 继续坚持以下原则：

```txt
先 mock，后真实 API
先跑通，再优化
Gateway 是统一入口和调度中心
Memory 是内部工具
Model Provider 是可替换的模型适配器
Audit Logger 是旁路记录，不应该影响主流程
任何一步失败都不能让整个程序直接崩溃
不要过早引入 MCP / 多 Agent / 前端 / 权限系统
```