﻿﻿﻿﻿﻿﻿﻿# Agent-Rebuild 生产级架构方�?
## 1. Executive Summary

`agent-rebuild` 是一个功能完整的 AI Agent 平台，具�?Gateway、AgentRunner、ToolCallExecutor、Memory、Session、WebSocket 传输�?Windows 本地执行能力。但当前架构存在 **6 �?P0 级生产风�?*�?
| # | 风险 | 严重�?| 当前状�?|
|---|------|--------|----------|
| 1 | **零成本追�?* �?�?token 计数、无预算、无成本可见�?| P0 | 完全缺失 |
| 2 | **file.read 无大小限�?* �?读取 50MB 文件可导�?OOM | P0 | 无防�?|
| 3 | **token 估算�?chars/4** �?中文/代码场景误差 30-100% | P0 | 粗糙启发�?|
| 4 | **所有运行时状态仅在内�?* �?重启丢失全部状�?| P1 | 无持久化 |
| 5 | **无缓存层** �?相同文件反复读取、相同问题反复调 API | P1 | 完全缺失 |
| 6 | **无代码索�?* �?大仓库只能靠 grep，无符号�?依赖�?| P1 | 仅有 Memory |

**核心结论**：当前架构适合原型验证，不适合生产使用。需要在 **4 �?Phase** 内完成改造，每个 Phase 可独立交付�?
---

## 2. Current Gaps（按领域分类�?
### 2.1 Context Scaling
- `buildTranscriptContext` 限制 4000 chars / 每条 500 chars �?复杂任务上下文不�?- 无分层上下文模型（系�?仓库/模块/任务/历史/工具结果混在一起）
- `file.read` 无大小限制，可一次注入数 MB 到上下文
- `contextCompressor` �?4 层管道依赖不准确�?token 估算

### 2.2 Retrieval Quality
- 无源代码索引（AST/符号�?依赖图）
- Memory 系统仅索引手动存储的 markdown 文档
- 无文件摘要缓存，相同文件反复读取
- 无语义搜索（embedding 仅用�?Memory 文档�?
### 2.3 Caching
- 零缓存层：模型响应、文件内容、搜索结果、embedding 均无缓存
- 幂等性存储仅在内存，重启丢失
- 重放缓冲区仅在内存，重启丢失

### 2.4 Reliability
- Rate limiter / Circuit breaker 仅在内存，无法水平扩�?- Session store �?JSON 文件，无锁，无备�?- Run 状态丢失，无法恢复中断的请�?- 同步文件 I/O 阻塞事件循环

### 2.5 Observability
- MetricsCollector 仅在内存，无导出
- 无分布式追踪（requestId 未贯穿全链路�?- �?token/cost 指标
- SLO 违规无告�?
### 2.6 Safety
- �?per-session token 预算
- �?spending cap
- PermissionPolicy �?shell.run �?approved 逻辑已修复，但无细粒度审�?
### 2.7 Testing
- 43 个单元测试文件，覆盖良好
- 无集成测试、无负载测试、无混沌测试
- 无端到端请求管道测试

---

## 3. Target Production Architecture

```
┌─────────────────────────────────────────────────────────────�?�?                    Client Layer                            �?�? ┌──────────�? ┌──────────�? ┌──────────�? ┌──────────�?  �?�? �? Web UI  �? �?  CLI    �? �?Desktop  �? �?  API    �?  �?�? └────┬─────�? └────┬─────�? └────┬─────�? └────┬─────�?  �?�?      └──────────────┼──────────────┼──────────────�?       �?�?                     �?                                     �?�?             WebSocket / HTTP                               �?└──────────────────────┬──────────────────────────────────────�?                       �?┌─────────────────────────────────────────────────────────────�?�?                  Request Orchestration                     �?�? ┌──────────────�? ┌──────────────�? ┌──────────────────�? �?�? �? WS Router   �? �? Run Manager �? �? Rate Limiter    �? �?�? �? + Auth      �? �? + Abort     �? �? + Circuit Break �? �?�? └──────┬───────�? └──────┬───────�? └────────┬─────────�? �?�?        └─────────────────┼───────────────────�?           �?�?                          �?                                �?�? ┌──────────────────────────────────────────────────────�? �?�? �?             AgentRunner (Tool Loop)                  �? �?�? �? ┌─────────────�? ┌─────────────�? ┌──────────────�?�? �?�? �? �? Context     �? �? Model      �? �? Tool Call   �?�? �?�? �? �? Assembly    │──�? Provider   │──�? Executor    �?�? �?�? �? �? (Layered)   �? �? (w/ Cache) �? �? (Sandboxed) �?�? �?�? �? └──────┬───────�? └──────┬──────�? └──────┬───────�?�? �?�? �?        �?                �?                �?        �? �?�? �?        �?                �?                �?        �? �?�? �? ┌─────────────�? ┌─────────────�? ┌──────────────�?�? �?�? �? �?Token/Cost  �? �? Response   �? �? Tool Result �?�? �?�? �? �?Tracker     �? �? Cache      �? �? Cache       �?�? �?�? �? └─────────────�? └─────────────�? └──────────────�?�? �?�? └──────────────────────────────────────────────────────�? �?└──────────────────────────┬──────────────────────────────────�?                           �?┌─────────────────────────────────────────────────────────────�?�?                   Intelligence Layer                       �?�? ┌──────────────�? ┌──────────────�? ┌──────────────────�? �?�? �? Repo Index  �? �? Memory      �? �? File Summary    �? �?�? �? (Symbols,   �? �? (Hybrid     �? �? Cache           �? �?�? �?  Deps, Map) �? �?  Search)    �? �? (Hash-keyed)    �? �?�? └──────────────�? └──────────────�? └──────────────────�? �?└──────────────────────────┬──────────────────────────────────�?                           �?┌─────────────────────────────────────────────────────────────�?�?                   Storage Layer                            �?�? ┌──────────────�? ┌──────────────�? ┌──────────────────�? �?�? �? SQLite      �? �? JSON Store  �? �? File System     �? �?�? �? (Sessions,  �? �? (Config,    �? �? (Transcripts,   �? �?�? �?  Memory,    �? �?  Metadata)  �? �?  Tool Results,  �? �?�? �?  Metrics)   �? �?             �? �?  Index Cache)   �? �?�? └──────────────�? └──────────────�? └──────────────────�? �?└─────────────────────────────────────────────────────────────�?                           �?┌─────────────────────────────────────────────────────────────�?�?                   Observability Layer                      �?�? ┌──────────────�? ┌──────────────�? ┌──────────────────�? �?�? �? Audit       �? �? Metrics     �? �? Tracing         �? �?�? �? Logger      �? �? (Prometheus �? �? (OpenTelemetry) �? �?�? �? (JSONL)     �? �?  export)    �? �?                 �? �?�? └──────────────�? └──────────────�? └──────────────────�? �?└─────────────────────────────────────────────────────────────�?```

### 3.1 模块边界定义

| 模块 | 职责 | 同步/异步 |
|------|------|-----------|
| **Request Orchestration** | 认证、限流、熔断、请求路由、Abort 管理 | 同步（入口） |
| **AgentRunner** | 工具循环、模型调用、上下文组装 | 同步（单请求内） |
| **Context Assembly** | 分层上下文构建、token 预算分配 | 同步 |
| **Model Provider** | API 调用、响应解析、usage 提取 | 同步（含流式�?|
| **Tool Executor** | 工具调度、沙箱执行、结果收�?| 同步 |
| **Repo Index** | 源代码索引、符号表、依赖图 | **后台异步** |
| **Memory** | 混合搜索、embedding、记忆写�?| 异步（写入）/ 同步（读取） |
| **Cache Layer** | 文件摘要缓存、响应缓存、检索缓�?| 同步 |
| **Token/Cost Tracker** | token 计数、成本估算、预算检�?| 同步 |
| **Observability** | 审计日志、指标导出、追踪传�?| 异步（写入） |

---

## 4. Context-Window Strategy for Large Codebases

### 4.1 分层上下文模�?
```
┌─────────────────────────────────────────────�?�? Layer 0: Stable System Context (固定)       �? ~2,000 tokens
�? - 系统提示词、工具列表、安全规�?           �?├─────────────────────────────────────────────�?�? Layer 1: Repository Map (按需)              �? ~1,000 tokens
�? - 项目结构摘要、语言/框架、关键目�?        �?├─────────────────────────────────────────────�?�? Layer 2: Task Working Set (动�?            �? ~4,000 tokens
�? - 当前任务相关文件的摘�?符号               �?�? - �?retrieval pipeline �?repo index 选取  �?├─────────────────────────────────────────────�?�? Layer 3: Recent Transcript (滑动窗口)       �? ~3,000 tokens
�? - 最�?N �?user/assistant 消息             �?�? - 每条截断�?500 chars                       �?├─────────────────────────────────────────────�?�? Layer 4: Tool Result Evidence (最�?        �? ~8,000 tokens
�? - 最近工具调用的结果                         �?�? - 大结果自动截�?摘要                       �?├─────────────────────────────────────────────�?�? Layer 5: Current User Input                 �? ~2,000 tokens
�? - 当前用户消息                               �?└─────────────────────────────────────────────�?                 总预�? ~20,000 tokens (默认)
```

### 4.2 Token 预算分配

```typescript
interface ContextBudget {
  systemContext: number;      // 2,000  (固定)
  repoMap: number;            // 1,000  (按需)
  taskWorkingSet: number;     // 4,000  (动态，可压�?
  recentTranscript: number;   // 3,000  (滑动窗口)
  toolResults: number;        // 8,000  (最新优先，旧的截断)
  currentInput: number;       // 2,000  (用户消息)
  reserve: number;            // 预留给模型输�?}
```

### 4.3 文件内容 vs 摘要 vs 符号的决策规�?
| 场景 | 策略 |
|------|------|
| 用户明确要求读取某文�?| 读取全文，但截断�?`maxFileReadChars`（默�?8000�?|
| 模型需要了解项目结�?| 返回 `repo.map`（目录树 + 语言统计�?|
| 模型需要定位函�?�?| 返回 `repo.symbols`（符号名 + 文件 + 行号�?|
| 模型需要理解某模块 | 返回 `file.summary`（从缓存获取，按需生成�?|
| 模型需要修改代�?| 返回文件全文（受 `maxFileReadChars` 限制�?|
| 工具结果超过 5KB | 自动持久化到磁盘，上下文中只放摘�?+ 路径 |

---

## 5. Caching and Token-Control Plan

### 5.1 Cache Layers

#### 5.1.1 File Summary Cache
```
Key: fileHash (SHA-256 of file content)
Value: { summary: string, symbols: Symbol[], lastIndexed: number }
Storage: SQLite table `file_summaries`
TTL: Until file content changes (hash-based invalidation)
```

#### 5.1.2 Retrieval Cache
```
Key: queryHash (SHA-256 of normalized query + sessionId)
Value: { results: SearchResult[], timestamp: number }
Storage: In-memory LRU (max 200 entries)
TTL: 5 minutes (same session), 0 (different session)
```

#### 5.1.3 Model Response Cache (optional, for deterministic subproblems)
```
Key: promptHash (SHA-256 of normalized prompt + model + temperature)
Value: { response: string, usage: Usage, timestamp: number }
Storage: In-memory LRU (max 50 entries)
TTL: 10 minutes
Scope: Only for tool-loop JSON parsing retries, not for general chat
```

#### 5.1.4 Embedding Cache
```
Key: textHash (SHA-256 of text)
Value: Float32Array
Storage: SQLite table `embedding_cache`
TTL: Permanent (embeddings are deterministic for same text+model)
```

### 5.2 Token/Cost Instrumentation

```typescript
interface UsageRecord {
  requestId: string;
  sessionId: string;
  modelProvider: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  cacheHit: boolean;
  latencyMs: number;
  toolCallCount: number;
  toolRetryCount: number;
  timestamp: number;
}
```

#### 实现路径�?1. `ModelResponse` 接口增加 `usage` 字段
2. `openAiCompatibleProvider` �?API 响应中提�?`usage`
3. `tokenPlanProvider` 同样提取 `usage`
4. `agentRunner` 在每次模型调用后记录 `UsageRecord`
5. `metricsCollector` 增加 token/cost 聚合指标
6. 前端 `runtime.status` 事件中增�?token/cost 统计

### 5.3 每模�?Token 定价�?
```typescript
const MODEL_PRICING: Record<string, { promptPer1k: number; completionPer1k: number }> = {
  "MiniMax-M2.7":            { promptPer1k: 0.001,   completionPer1k: 0.008 },
  "gpt-4o":                  { promptPer1k: 0.005,   completionPer1k: 0.015 },
  "gpt-4o-mini":             { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  "claude-sonnet-4-20250514": { promptPer1k: 0.003,  completionPer1k: 0.015 },
};
```

---

## 6. Reliability and Observability Plan

### 6.1 Reliability Requirements

| 机制 | 当前状�?| 目标 |
|------|----------|------|
| **幂等�?* | 内存 Map，重启丢�?| SQLite 持久化，TTL 24h |
| **重试** | AgentRunner �?1 次重�?| 指数退避，最�?3 次，区分可重�?不可重试错误 |
| **熔断** | CircuitBreaker 在内�?| SQLite 持久化状态，重启恢复 |
| **超时** | 每层独立超时�?0s/30s/10s�?| 统一超时策略，请求级 deadline 传播 |
| **事件持久�?* | ReplayBuffer 在内�?| SQLite 持久化，TTL 1h |
| **重启恢复** | �?| �?SQLite 恢复 session 状态、circuit breaker 状�?|
| **背压** | �?`backpressure.ts`，基于内�?| 持久�?pending 计数 |
| **并发会话** | 无锁 Session store | SQLite WAL 模式，天然支持并发读�?|

### 6.2 Observability Requirements

#### 6.2.1 Metrics（Prometheus 格式�?
```
# Token metrics
agent_prompt_tokens_total{model="MiniMax-M2.7",session="xxx"} 1234
agent_completion_tokens_total{model="MiniMax-M2.7",session="xxx"} 567
agent_cost_usd_total{model="MiniMax-M2.7"} 0.045

# Latency metrics
agent_request_duration_seconds{quantile="0.5"} 2.3
agent_request_duration_seconds{quantile="0.95"} 8.1
agent_model_call_duration_seconds{model="MiniMax-M2.7"} 3.2
agent_tool_execution_duration_seconds{tool="file.write"} 0.05

# Reliability metrics
agent_tool_calls_total{tool="file.write",status="success"} 45
agent_tool_calls_total{tool="shell.run",status="failed"} 3
agent_retries_total{reason="parse_error"} 2
agent_circuit_breaker_state{upstream="tokenplan"} 0

# Cache metrics
agent_cache_hits_total{cache="file_summary"} 120
agent_cache_misses_total{cache="file_summary"} 30
agent_cache_size{cache="retrieval"} 45

# Session metrics
agent_active_sessions 3
agent_messages_total{role="user"} 150
agent_messages_total{role="assistant"} 148
```

#### 6.2.2 Distributed Tracing

每个请求生成 `traceId`，贯穿：
```
WS Request �?Router �?AgentRunner �?[Model Call, Tool Call] �?Response
  traceId: abc123
    span: ws.request (1200ms)
      span: agent.loop.step1 (800ms)
        span: model.call (600ms)
        span: tool.execute.file.write (50ms)
      span: agent.loop.step2 (400ms)
        span: model.call (350ms)
```

#### 6.2.3 SLO Alerting

```typescript
interface SLOConfig {
  latencyP95Ms: number;        // 10,000
  errorRateThreshold: number;  // 0.05 (5%)
  tokenBudgetPerSession: number; // 100,000
  dailyCostCapUsd: number;     // 10.00
}
```

---

## 7. Phased Implementation Roadmap

### Phase 1: Token/Cost Observability + File Safety (P0, 1-2 weeks)

**目标**：让系统可度量、可控制成本、防 OOM

| # | Task | File(s) | Effort | Priority |
|---|------|---------|--------|----------|
| 1.1 | `ModelResponse` 增加 `usage` 字段 | `packages/model/types.ts` | S | P0 |
| 1.2 | `openAiCompatibleProvider` 提取 API usage | `packages/model/openAiCompatibleProvider.ts` | S | P0 |
| 1.3 | `tokenPlanProvider` 提取 API usage | `packages/model/tokenPlanProvider.ts` | S | P0 |
| 1.5 | `UsageRecord` 数据结构 + SQLite �?| `packages/storage/src/usageStore.ts` (new) | M | P0 |
| 1.6 | AgentRunner 记录每次模型调用�?usage | `packages/gateway/agentRunner.ts` | M | P0 |
| 1.7 | MetricsCollector 增加 token/cost 聚合 | `packages/gateway/metricsCollector.ts` | M | P0 |
| 1.8 | `file.read` 增加大小限制（默�?64KB�?| `packages/gateway/tools/sandboxedFile.ts` | S | P0 |
| 1.9 | `file.read` 超限时自动截�?+ 警告 | `packages/gateway/tools/sandboxedFile.ts` | S | P0 |
| 1.10 | 前端显示 token/cost 统计 | `apps/web-ui/src/App.tsx` | M | P0 |
| 1.11 | Per-session token 预算检�?| `packages/gateway/agentRunner.ts` | M | P0 |
| 1.12 | 替换 `chars/4` �?`tiktoken` �?`@anthropic/tokenizer` | `packages/gateway/contextCompressor.ts` | L | P0 |

### Phase 2: Source Code Indexing + File Summary Cache (P1, 2-3 weeks)

**目标**：让 Agent 能理解大仓库结构

| # | Task | File(s) | Effort | Priority |
|---|------|---------|--------|----------|
| 2.1 | `RepoIndexer` �?扫描项目文件�?| `packages/gateway/repoIndexer.ts` (new) | M | P1 |
| 2.2 | 文件摘要生成（调用模�?or 规则提取�?| `packages/gateway/fileSummarizer.ts` (new) | M | P1 |
| 2.3 | 符号索引（函�?�?接口�?+ 位置�?| `packages/gateway/symbolIndex.ts` (new) | L | P1 |
| 2.4 | 依赖图（import/require 关系�?| `packages/gateway/dependencyGraph.ts` (new) | L | P1 |
| 2.5 | `file_summaries` SQLite �?+ 缓存逻辑 | `packages/storage/src/fileSummaryStore.ts` (new) | M | P1 |
| 2.6 | 文件 hash 变更检�?+ 增量重建 | `packages/gateway/repoIndexer.ts` | M | P1 |
| 2.7 | `repo.map` 工具 �?返回项目结构摘要 | `packages/gateway/tools/repoTools.ts` (new) | S | P1 |
| 2.8 | `repo.symbols` 工具 �?按名称搜索符�?| `packages/gateway/tools/repoTools.ts` (new) | M | P1 |
| 2.9 | Git-aware 失效（监�?`HEAD` 变化�?| `packages/gateway/repoIndexer.ts` | S | P1 |
| 2.10 | 上下文组装集�?repo index | `packages/gateway/contextBuilder.ts` | M | P1 |

### Phase 3: Caching + Context Strategy (P1, 2 weeks)

**目标**：减�?API 调用、优化上下文质量

| # | Task | File(s) | Effort | Priority |
|---|------|---------|--------|----------|
| 3.1 | 文件内容 LRU 缓存（hash-keyed�?| `packages/gateway/fileContentCache.ts` (new) | S | P1 |
| 3.2 | 检索结�?LRU 缓存 | `packages/gateway/retrievalCache.ts` (new) | S | P1 |
| 3.3 | Embedding 缓存（SQLite�?| `packages/storage/src/embeddingCacheStore.ts` (new) | M | P1 |
| 3.4 | 分层上下文组装器 | `packages/gateway/layeredContextBuilder.ts` (new) | L | P1 |
| 3.5 | Token 预算分配�?| `packages/gateway/tokenBudgetAllocator.ts` (new) | M | P1 |
| 3.6 | 工具结果自动摘要�?5KB 时） | `packages/gateway/contextCompressor.ts` | M | P1 |
| 3.7 | 幂等性存储迁移到 SQLite | `packages/gateway/ws/idempotencyStore.ts` | M | P1 |
| 3.8 | 重放缓冲区迁移到 SQLite | `packages/gateway/ws/replayBuffer.ts` | M | P1 |

### Phase 4: Reliability + Observability + Testing (P2, 2-3 weeks)

**目标**：生产级可靠性和可观测�?
| # | Task | File(s) | Effort | Priority |
|---|------|---------|--------|----------|
| 4.1 | Circuit breaker 状态持久化 | `packages/gateway/circuitBreaker.ts` | M | P2 |
| 4.2 | Session store 迁移�?SQLite | `packages/gateway/sessionStore.ts` | L | P2 |
| 4.3 | 指标导出（Prometheus `/metrics`�?| `packages/gateway/metricsExporter.ts` (new) | M | P2 |
| 4.4 | 分布式追踪（traceId 贯穿�?| `packages/gateway/tracing.ts` (new) | M | P2 |
| 4.5 | SLO 告警（日�?+ webhook�?| `packages/gateway/sloAlert.ts` (new) | S | P2 |
| 4.6 | 异步文件 I/O（`fs.promises`�?| `packages/gateway/tools/sandboxedFile.ts` | M | P2 |
| 4.7 | 大结果持久化清理（TTL + LRU�?| `packages/gateway/contextCompressor.ts` | S | P2 |
| 4.8 | 集成测试：完整请求管�?| `tests/integration/fullPipeline.test.ts` (new) | L | P2 |
| 4.9 | 负载测试：并发会�?| `tests/load/concurrentSessions.test.ts` (new) | L | P2 |
| 4.10 | 混沌测试：进程崩溃恢�?| `tests/chaos/crashRecovery.test.ts` (new) | L | P2 |

---

## 8. Specific File/Module Change List

### 8.1 修改现有文件

| File | Change | Phase |
|------|--------|-------|
| `packages/model/types.ts` | `ModelResponse` 增加 `usage: { promptTokens, completionTokens, totalTokens }` | 1 |
| `packages/model/openAiCompatibleProvider.ts` | `extractContent` 提取 `response.usage` | 1 |
| `packages/model/tokenPlanProvider.ts` | 同上 | 1 |

| `packages/gateway/agentRunner.ts` | 记录 UsageRecord；token 预算检查；集成 repo index | 1, 2 |
| `packages/gateway/contextCompressor.ts` | 替换 `chars/4` �?tokenizer；清理大结果 TTL | 1, 4 |
| `packages/gateway/metricsCollector.ts` | 增加 token/cost/cache 指标字段 | 1 |
| `packages/gateway/tools/sandboxedFile.ts` | `file.read` 大小限制；异�?I/O | 1, 4 |
| `packages/gateway/contextBuilder.ts` | 集成 repo map 和分层上下文 | 2, 3 |
| `packages/gateway/ws/idempotencyStore.ts` | 迁移�?SQLite | 3 |
| `packages/gateway/ws/replayBuffer.ts` | 迁移�?SQLite | 3 |
| `packages/gateway/circuitBreaker.ts` | 状态持久化�?SQLite | 4 |
| `packages/gateway/sessionStore.ts` | 迁移�?SQLite WAL 模式 | 4 |
| `packages/gateway/ws/wsServer.ts` | 导出 Prometheus `/metrics` 端点 | 4 |
| `apps/web-ui/src/App.tsx` | 显示 token/cost 统计面板 | 1 |

### 8.2 新建文件

| File | Purpose | Phase |
|------|---------|-------|
| `packages/storage/src/usageStore.ts` | Token usage 记录存储 | 1 |
| `packages/gateway/repoIndexer.ts` | 项目文件扫描 + 索引 | 2 |
| `packages/gateway/fileSummarizer.ts` | 文件摘要生成 | 2 |
| `packages/gateway/symbolIndex.ts` | 符号索引（函�?�?接口�?| 2 |
| `packages/gateway/dependencyGraph.ts` | import/require 依赖�?| 2 |
| `packages/storage/src/fileSummaryStore.ts` | 文件摘要缓存�?| 2 |
| `packages/gateway/tools/repoTools.ts` | repo.map / repo.symbols 工具 | 2 |
| `packages/gateway/fileContentCache.ts` | 文件内容 LRU 缓存 | 3 |
| `packages/gateway/retrievalCache.ts` | 检索结�?LRU 缓存 | 3 |
| `packages/storage/src/embeddingCacheStore.ts` | Embedding 缓存�?| 3 |
| `packages/gateway/layeredContextBuilder.ts` | 分层上下文组装器 | 3 |
| `packages/gateway/tokenBudgetAllocator.ts` | Token 预算分配�?| 3 |
| `packages/gateway/metricsExporter.ts` | Prometheus 指标导出 | 4 |
| `packages/gateway/tracing.ts` | 分布式追�?| 4 |
| `packages/gateway/sloAlert.ts` | SLO 告警 | 4 |
| `tests/integration/fullPipeline.test.ts` | 端到端集成测�?| 4 |
| `tests/load/concurrentSessions.test.ts` | 并发负载测试 | 4 |
| `tests/chaos/crashRecovery.test.ts` | 崩溃恢复测试 | 4 |

---

## 9. Test and Rollout Checklist

### Phase 1 验收标准

- [ ] 每次模型调用记录 `promptTokens`、`completionTokens`、`estimatedCostUsd`
- [ ] `file.read` 超过 64KB 自动截断并返回警�?- [ ] `contextCompressor` 使用真实 tokenizer（误�?<10%�?- [ ] 前端 `runtime.status` 包含 session token/cost 统计
- [ ] Per-session token 超预算时返回明确错误
- [ ] 所有现有单元测试通过
- [ ] 新增 `usageStore` 单元测试

### Phase 2 验收标准

- [ ] `repo.map` 工具返回项目目录�?+ 语言统计
- [ ] `repo.symbols` 工具按名称搜索返回文�?+ 行号
- [ ] 文件摘要缓存命中�?>60%（在重复读取场景�?- [ ] 符号索引覆盖 TS/JS/Python/C++ 文件
- [ ] 文件内容变更后索引自动失�?- [ ] 新增 `repoIndexer`、`symbolIndex` 单元测试

### Phase 3 验收标准

- [ ] 分层上下文组装器各层 token 用量在预算内
- [ ] 文件内容缓存命中减少 50%+ 的重复读�?- [ ] 检索缓存命中减�?30%+ 的重复搜�?- [ ] 幂等�?重放缓冲区重启后持久�?- [ ] 新增 `layeredContextBuilder`、`tokenBudgetAllocator` 单元测试

### Phase 4 验收标准

- [ ] `/metrics` 端点返回 Prometheus 格式指标
- [ ] traceId 贯穿 WS �?AgentRunner �?Model �?Tool 全链�?- [ ] SLO 违规时输出告警日�?- [ ] Circuit breaker 状态重启后恢复
- [ ] Session store 使用 SQLite WAL，支持并发读�?- [ ] 集成测试覆盖完整请求管道
- [ ] 负载测试验证 10 并发会话稳定�?- [ ] 混沌测试验证进程崩溃后状态恢�?
### Rollout 策略

```
Phase 1 (Week 1-2)  ─── 开发环境验�?─── 所有开发者本地测�?Phase 2 (Week 3-5)  ─── 小规模试�?─── 2-3 人内部使用，收集反馈
Phase 3 (Week 5-7)  ─── 扩大试用 ─── 5-10 人使用，监控指标
Phase 4 (Week 7-10) ─── 生产就绪 ─── 全量部署，持续监�?```

每个 Phase 完成后：
1. 运行全量单元测试
2. 运行集成测试（Phase 4 新增�?3. 检�?TypeScript 编译零错�?4. 手动验证核心流程（创建文件、读取文件、shell 命令�?5. 检查审计日志完整�?