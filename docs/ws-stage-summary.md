# WebSocket Gateway Stage Summary

## Stage Goal

This stage turns the local Gateway into a typed WebSocket Gateway suitable for multiple local clients while preserving the existing REPL-first workflow.

## Architecture Changes

- Runtime initialization moved into `createGatewayRuntime()`.
- REPL and WS entries share the same Gateway Runtime.
- WebSocket routing is implemented as a thin transport layer over existing Gateway, Session, Memory, Tool, Sandbox, Audit, and MCP modules.

## Added Modules

- `protocol.ts`: typed request, response, event, method, event, and error definitions.
- `auth.ts`: token, origin, and WS limit configuration.
- `schemas.ts`: method parameter validation.
- `connectionManager.ts`: clients, session subscriptions, event send, replay integration, and backpressure.
- `runManager.ts`: run lifecycle and AbortController ownership.
- `router.ts`: method routing and Gateway integration.
- `wsServer.ts`: upgrade auth, message handling, heartbeat, graceful shutdown.
- `redaction.ts`: secret redaction for audit output.
- `auditTail.ts`: safe audit log tailing.
- `memoryWrite.ts`: controlled memory write entry.
- `metrics.ts`: WS layer metrics.

## Protocol Overview

The protocol has three message types: `req`, `res`, and `event`. Session-scoped operations require explicit `sessionId`. Long-running chat returns immediately with a `runId` and completes through events.

## Security Overview

The WS layer adds token auth, origin checks, schema validation, message size limits, connection limits, message rate limits, run concurrency limits, backpressure, audit logging, and redaction.

Tool execution still runs through `ToolCallExecutor.execute()`. The WS layer does not bypass PermissionPolicy, Sandbox, ProjectBoundary, or Audit.

## Run Lifecycle

Runs are created by `chat.send`, tracked by RunManager, and receive an AbortController. `chat.cancel` aborts the controller and emits `run.cancelled`.

Expected successful event order:

```txt
run.started -> chat.delta* -> chat.completed -> run.finished
```

## Tool Safety Path

`tool.call` creates a Gateway tool-call request, includes session permission mode and project boundary, then calls `ToolCallExecutor.execute()`. Results are surfaced as `tool.finished`, `tool.denied`, or `tool.failed`.

## Testing and Validation

The stage includes unit coverage for protocol, auth, schemas, redaction, idempotency, replay buffer, run manager, connection manager, router, cancellation, approval, audit tail, memory write, backpressure, and WS server error handling.

Final validation commands:

```bash
npm run typecheck
npm run build
npm test
npm run gateway:smoke:ws
```

## Current Limits

- ReplayBuffer is in-memory and is not a durable event log.
- Provider streaming capability depends on the configured provider.
- `session.rename` remains limited to the current session.
- Backpressure can drop low-priority deltas for slow clients.

## Next Stage Suggestions

- Minimal Web UI.
- VS Code Client.
- Run Timeline.
- Tool Timeline.
- Multi-Agent Timeline.
- Persistent event log.
- Fine-grained permission approval UI.
