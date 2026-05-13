# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Agent Gateway -- a Windows-local AI agent runtime that accepts requests via CLI REPL or WebSocket, enriches them with memory and project context, sends them to an LLM in an agentic tool-use loop, executes tool calls on the local machine, and returns structured responses. Written in TypeScript (6.x), targeting Windows 10/11 with PowerShell.

The project is evolving from a working prototype toward a production-grade platform for large repositories. See `PRODUCTION_ARCHITECTURE.md` for the phased roadmap covering token/cost observability, source-code indexing, caching layers, and reliability hardening.

## Current Development Status (2026-05-10)

The working tree has significant uncommitted changes relative to the last commit (`1abc915`). Key areas in progress:

**Production readiness (P0 items from PRODUCTION_ARCHITECTURE.md):**
- `MetricsCollector` now tracks token usage (prompt/completion/total), cost (cents), tool call counts, and retry counts per request
- `AgentRunner` expanded significantly (+654 lines) -- enhanced tool loop, DevTask handling, token/cost reporting
- `ContextCompressor` improved with CJK-aware token estimation (`estimateTokensFromText`)
- `LocalCommandRunner` expanded with more POSIX-to-PowerShell translation patterns and improved error handling

**Cleanup and consolidation:**
- `DeepSeekProvider` removed from `packages/model/` (was 563 lines) -- only OpenAiCompatible, TokenPlan, and Mock remain
- 17 test files removed (consolidated or obsolete); 24 test files remain
- 7 old docs removed from `docs/` (v0.1/v0.4/v0.5 READMEs, architecture-upgrade, to_do, ws-smoke-test, ws-stage-summary)
- WS docs retained: `ws-gateway.md`, `ws-protocol.md`, `ws-security.md`, `ws-final-checklist.md`

**Web UI:**
- `tokens.css` expanded (~949 lines) with comprehensive design tokens and layout styles
- `App.tsx` updated (~259 lines changed)

**Infrastructure:**
- `.gitignore` expanded with proper log directory structure (audit, tool-results, test-results, runtime, errors, archive)
- `workspace/MEMORY.md` updated with accumulated memory entries
- TypeScript upgraded to 6.x (`@types/node` 25.x, `@types/ws` 8.x)

## Commands

### Development
```bash
npm run dev              # Start gateway in REPL mode (tsx apps/gateway/src/main.ts)
npm run gateway:ws       # Start WebSocket server (tsx apps/gateway/src/ws-main.ts)
npm run web:dev          # Start web UI dev server (Vite, port 3000, proxies /v1/ws to ws://127.0.0.1:8787)
```

### Build & Typecheck
```bash
npm run build            # tsc -> dist/
npm run typecheck        # tsc --noEmit (fast check without emit)
```

### Testing
```bash
npm test                 # Run all tests (custom runner: scripts/run-tests.ts, uses node:test + tsx)
npm run test:smoke       # Smoke test: tests/devTaskLoop.test.ts
```

Run a single test file:
```bash
node --import tsx --test tests/agent.test.ts
```

Live API tests are gated behind `RUN_LIVE_API_TESTS=1` env var (see `tests/helpers/realApiTestHelper.ts`).

### Smoke & Health Checks
```bash
npm run gateway:smoke:all     # All smoke tests (mock provider)
npm run gateway:detect        # Full system health check (requires live API keys)
npm run gateway:detect:offline # Health check without live API calls
npm run gateway:check         # Full pipeline: typecheck + build + test + smoke + detect
```

### Utilities
```bash
npm run reindex           # Rebuild memory FTS + embedding index
npm run backfill:embeddings # Backfill pending embeddings
npm run scheduler         # Background loop: reindex, compact, archive
```

### Web UI (separate sub-project)
```bash
npm run web:build         # tsc -b && vite build (in apps/web-ui/)
```

## Architecture

### Request Flow

```
Client (REPL or WebSocket)
  -> Gateway.handle()
     -> rate limit / circuit breaker check
     -> Branch:
        [default]  AgentRunner.run()   -- single-agent tool-use loop
        [optional] ReviewGraphRunner   -- 7-node multi-agent pipeline
     -> session memory update + memory auto-writer
     -> GatewayResponse
```

### Key Subsystems

**Gateway** (`packages/gateway/`, 99 source files): The core runtime. `runtime.ts` wires all subsystems together into a `GatewayRuntime` object reused by CLI, WS, and tests. `gateway.ts` is the top-level orchestrator; `agentRunner.ts` runs the agentic tool loop.

**Agent Loop** (`agentRunner.ts`): Up to `maxToolCalls` (default 5) iterations. Each iteration: build context -> call model -> parse JSON response -> if `tool_call`, execute tool and loop; if `final`, return. Anti-hallucination check forces retry if model claims success without tool evidence.

**Model Protocol**: The model communicates via structured JSON:
- `{"type":"tool_call","tool":"name","args":{...}}` to invoke tools
- `{"type":"final","content":"markdown"}` to finish

Plain text responses are re-prompted for JSON format.

**Context Builder** (`contextBuilder.ts`): Assembles the message array in order: system prompt -> bootstrap context (persona/memory files) -> mode context -> project context (file tree, symbols) -> session working memory -> user message + memory search results.

**Tool Execution** (`toolCallExecutor.ts`): 9-step pipeline: normalize input -> validate schema -> evaluate permission policy -> check project boundary -> sandbox checks -> capture mutation preflight -> execute -> post-execution normalization -> audit log.

**Session System** (`sessionManager.ts`, `sessionStore.ts`): Sessions persist to `workspace/sessions/`. Each session can bind to a project directory. Sessions track working memory, rolling summaries, approval tokens, and dev task state. Budget: 2M tokens / $20 per session (configurable via `GATEWAY_SESSION_TOKEN_BUDGET` / `GATEWAY_SESSION_COST_BUDGET_CENTS`).

**Memory** (`packages/memory/`): Hybrid search using FTS5 (trigram tokenizer for CJK) + vector embeddings (DashScope) merged via Reciprocal Rank Fusion with recency boost. Memory writer auto-classifies facts as daily vs long-term. Scheduler compacts daily memory older than 7 days.

**WebSocket** (`packages/gateway/ws/`): Protocol v1.0 on `/v1/ws`. `WsRequest`/`WsResponse`/`WsEvent` wire format. `chat.send` returns a `runId` immediately, then streams events (`chat.delta`, `tool.started`, `tool.finished`). Supports idempotency keys, event replay on reconnect, and backpressure protection.

**ReviewGraph** (`packages/gateway/reviewGraph/`): Optional 7-node multi-agent pipeline (Explore -> Plan -> Implement -> Test -> Verify -> Security -> Reviewer). Each node runs a sub-agent with its own tool policy. Test/verify failures trigger repair loops (max 3 rounds). Enable with `GATEWAY_AUTO_REVIEW_GRAPH_ENABLED=true`.

**Model Providers** (`packages/model/`): `OpenAiCompatibleProvider` (generic base for any OpenAI-compatible endpoint), `TokenPlanProvider` (MiniMax defaults), `MockModelProvider` (offline testing). Provider selection via env vars. All providers return `ModelUsage` (promptTokens/completionTokens/totalTokens) for cost tracking.

**Bootstrap** (`packages/core/src/bootstrap.ts`): Loads workspace markdown files (SOUL.md, USER.md, MEMORY.md, etc.) into the system prompt. Runs skill discovery across 7 directories, injecting up to 3 matched skills.

**WS Client SDK** (`packages/ws-client/`): Browser/Node reusable WebSocket client. `GatewayClient` wraps request/response, `ConnectionManager` handles reconnection, `RequestManager` manages requestId/timeout/idempotency keys, `EventDispatcher` dispatches events with `chat.delta` batching, `ResumeManager` tracks session/seq for disconnect recovery.

### Configuration

All gateway config is via `GATEWAY_*` environment variables (see `.env.example` for the full list). The config loader is `packages/gateway/config.ts`.

### Web UI

React 19 + Zustand 5 + Vite 6, located in `apps/web-ui/`. Monolithic `App.tsx` with 6 pages: Chat, Overview, Resources, Approvals, Memory, Audit. Design tokens and layout styles in `src/styles/tokens.css`. Uses `@ws-client` package (`packages/ws-client/`) for gateway communication -- provides request/response wrapping, reconnection, idempotency keys, event dispatch, `chat.delta` batching, and resume state management.

### Test Patterns

- Framework: `node:test` + `node:assert/strict`, run via `tsx`
- Test files: 24 test files in `tests/` covering agent runner, gateway, tools, WS, memory, session, skills, context compressor, ReviewGraph
- Mock model providers feed predetermined responses (see `SequenceModelProvider` in agent tests)
- Integration tests create real temp directories and verify filesystem side effects
- Cleanup in `finally` blocks with `fs.rmSync`
- Live API tests gated behind `RUN_LIVE_API_TESTS=1`

### Important Conventions

- All shell commands run via PowerShell on Windows (translated from POSIX in bootstrap)
- Path guard blocks dangerous host paths; project boundary enforcement constrains file/shell tools
- Timezone: Asia/Shanghai for all date helpers
- TypeScript 6.x with strict mode; no ESLint/Prettier configured
- SQLite database at `workspace/index/memory.sqlite` (WAL mode, FTS5 + vector tables)
- Token estimation uses CJK-aware heuristic (1.5 chars/token for CJK, 4 chars/token for Latin)
