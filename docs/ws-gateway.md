# WebSocket Gateway

The WebSocket Gateway is the typed local-agent entry point for web UI, VS Code clients, bot adapters, and multi-agent timeline clients. It is not a separate execution path. It reuses the same Gateway Runtime as the REPL.

## Architecture

`createGatewayRuntime()` builds the shared runtime:

```txt
SessionManager
GatewaySandbox
MCP Manager
ModelProvider
MemorySearch
ToolRegistry
ToolCallExecutor
Gateway
AuditLogger
Metrics
```

The REPL entry point (`apps/gateway/src/main.ts`) and the WebSocket entry point (`apps/gateway/src/ws-main.ts`) both use this runtime:

```txt
REPL client -> main.ts -> createGatewayRuntime() -> Gateway.handle()
WS client   -> ws-main.ts -> startGatewayWsServer() -> createGatewayRuntime() -> Gateway.handle()
```

This keeps session, memory, sandbox, tool, audit, and model behavior consistent across clients.

## Start

```bash
npm run gateway:ws
```

Default URL:

```txt
ws://127.0.0.1:8787/v1/ws
```

If `GATEWAY_WS_TOKEN` is set, clients must pass it with `?token=...` or `Authorization: Bearer ...`.

## Typical Flow

1. Connect to `/v1/ws`.
2. Send `connect` with protocol version `1.0`.
3. Call `session.list` or `session.create`.
4. Send `chat.send` with an explicit `sessionId`.
5. Listen for `run.started`, `chat.delta`, `chat.completed`, and `run.finished`.

## chat.send Lifecycle

`chat.send` validates input, checks session existence, applies run concurrency limits, creates a run, and calls `Gateway.handle()` with an `AbortSignal` and event callback.

Event order:

```txt
run.started
chat.delta*
tool.started/tool.finished/tool.denied/tool.failed*
chat.completed
run.finished
```

`chat.cancel` aborts the run controller. Cancellation is reported as `run.cancelled`, not `run.failed`.

## tool.call Lifecycle

`tool.call` requires `sessionId`, `toolName`, and object `input`. It builds a Gateway tool-call request and executes only through `ToolCallExecutor.execute()`.

The WS layer does not call `toolRegistry.invoke()` directly. Tool execution still passes through permission policy, sandbox, project boundary, audit, and output truncation.

## Current Limits

- ReplayBuffer is in-memory only and is not a durable event log.
- Provider-level streaming depends on the configured provider.
- `session.rename` remains limited to the current session for compatibility with the existing SessionManager behavior.
- Backpressure drops low-priority events such as `chat.delta` before disconnecting slow clients.

## Client Integration

Web UI, VS Code clients, and multi-agent timeline clients should treat the WS protocol as the stable integration layer:

- Use explicit `sessionId` on session-scoped operations.
- Persist the last received event `seq` and call `connect.resume` on reconnect.
- Render run and tool events as timelines.
- Treat `state.resync_required` as a signal to reload current state through request methods.
