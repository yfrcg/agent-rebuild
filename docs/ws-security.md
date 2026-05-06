# WebSocket Security

The WS Gateway exposes local agent capabilities to multiple clients. It keeps the existing Gateway safety chain and adds connection-level controls.

## Authentication

If `GATEWAY_WS_TOKEN` is set, every connection must provide it through:

```txt
ws://127.0.0.1:8787/v1/ws?token=...
Authorization: Bearer ...
```

The token is never printed by server logs, smoke output, docs, or tests.

## Origin Checks

The server validates the `Origin` header against `GATEWAY_WS_ALLOWED_ORIGINS`. Empty origin is allowed by default for local CLI and Node clients.

Localhost is not trusted by itself. A browser page from an unexpected origin can still attack local services, so token and origin checks are both enforced.

## Request Validation

`packages/gateway/ws/schemas.ts` validates method parameters before routing:

- Required fields must exist.
- String and object types are checked.
- `chat.send` input is limited to 64KB.
- WS messages are limited by `GATEWAY_WS_MAX_MESSAGE_BYTES` (default 1MB).
- `tool.call` input JSON is limited to 512KB.
- `memory.write` content is limited to 16KB.

Invalid input returns structured errors and must not crash the server.

## Rate and Resource Limits

Supported limits:

- `GATEWAY_WS_MAX_CONNECTIONS`
- `GATEWAY_WS_MAX_MESSAGE_BYTES`
- `GATEWAY_WS_MAX_RUNS_PER_CLIENT`
- `GATEWAY_WS_MAX_RUNS_TOTAL`
- `GATEWAY_WS_RATE_LIMIT_WINDOW_MS`
- `GATEWAY_WS_RATE_LIMIT_MAX_MESSAGES`

Rate-limited requests return `RATE_LIMITED` and are written to audit.

## Tool Safety Chain

WS `tool.call` never invokes tools directly. It creates a Gateway tool-call request and calls `ToolCallExecutor.execute()`.

The existing chain remains active:

- PermissionPolicy
- Sandbox
- ProjectBoundary
- AuditLogger
- Tool output truncation and artifact handling

## memory.write

`memory.write` uses controlled Gateway memory writers. It does not accept file paths and cannot write arbitrary files.

## audit.tail

`audit.tail` reads only the configured Gateway audit log. It does not accept a path parameter. JSONL parse errors are skipped, and returned data is redacted.

## Redaction

Redaction covers sensitive field names and string patterns, including:

- API keys
- token
- authorization
- cookie
- password
- secret
- private keys
- SSH keys

## Backpressure

Slow clients are isolated. If a socket buffers too much data, low-priority events such as `chat.delta` can be dropped. Important events close the slow client rather than blocking Gateway work.

## Graceful Shutdown

On `SIGINT` or `SIGTERM`, the WS server stops accepting new clients, emits `server.shutdown`, waits for active runs up to the configured timeout, cancels remaining runs, closes sockets, and then calls `runtime.close()`.

## Remaining Notes

ReplayBuffer is memory-only. Clients must handle `state.resync_required` by reloading state through request methods.
