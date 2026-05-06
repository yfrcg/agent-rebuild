# WebSocket Protocol

Protocol version: `1.0`

The server keeps v0.1 request compatibility and adds optional v1.0 capabilities. Clients should send `connect.params.protocolVersion = "1.0"` when possible.

## Message Types

Request:

```json
{
  "type": "req",
  "id": "req_001",
  "method": "runtime.status",
  "params": {},
  "idempotencyKey": "optional-key",
  "clientSeq": 1
}
```

Response:

```json
{
  "type": "res",
  "id": "req_001",
  "ok": true,
  "payload": {}
}
```

Event:

```json
{
  "type": "event",
  "seq": 1,
  "event": "run.started",
  "runId": "run_...",
  "sessionId": "session_...",
  "payload": {},
  "createdAt": "2026-05-05T00:00:00.000Z"
}
```

## Methods

- `connect`
- `ping`
- `runtime.status`
- `session.list`
- `session.get`
- `session.create`
- `session.rename`
- `session.bindProject`
- `session.getTranscript`
- `chat.send`
- `chat.cancel`
- `memory.search`
- `memory.write`
- `tool.list`
- `tool.call`
- `approval.list`
- `approval.confirm`
- `approval.reject`
- `audit.tail`

## Events

- `connected`
- `heartbeat`
- `run.started`
- `run.progress`
- `run.finished`
- `run.failed`
- `run.cancelled`
- `chat.completed`
- `chat.delta`
- `tool.started`
- `tool.finished`
- `tool.failed`
- `tool.denied`
- `approval.required`
- `approval.confirmed`
- `approval.rejected`
- `session.updated`
- `audit.append`
- `state.resync_required`
- `server.shutdown`

## Error Codes

- `BAD_REQUEST`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `PAYLOAD_TOO_LARGE`
- `RUN_CANCELLED`
- `POLICY_DENIED`
- `TOOL_FAILED`
- `MODEL_FAILED`
- `NOT_IMPLEMENTED`
- `INTERNAL_ERROR`

## Examples

Connect:

```json
{
  "type": "req",
  "id": "req_connect_001",
  "method": "connect",
  "params": {
    "protocolVersion": "1.0",
    "clientName": "manual-test"
  }
}
```

Session list:

```json
{
  "type": "req",
  "id": "req_session_list_001",
  "method": "session.list"
}
```

Chat send:

```json
{
  "type": "req",
  "id": "req_chat_001",
  "method": "chat.send",
  "params": {
    "sessionId": "<SESSION_ID>",
    "input": "Summarize the current Gateway status in one sentence."
  },
  "idempotencyKey": "manual-chat-001"
}
```

Tool list:

```json
{
  "type": "req",
  "id": "req_tool_list_001",
  "method": "tool.list"
}
```

Tool call:

```json
{
  "type": "req",
  "id": "req_tool_call_001",
  "method": "tool.call",
  "params": {
    "sessionId": "<SESSION_ID>",
    "toolName": "file.read",
    "input": {
      "path": "package.json"
    }
  },
  "idempotencyKey": "manual-tool-read-package"
}
```

Memory search:

```json
{
  "type": "req",
  "id": "req_memory_search_001",
  "method": "memory.search",
  "params": {
    "query": "WebSocket Gateway"
  }
}
```

Audit tail:

```json
{
  "type": "req",
  "id": "req_audit_tail_001",
  "method": "audit.tail",
  "params": {
    "limit": 20
  }
}
```

Chat cancel:

```json
{
  "type": "req",
  "id": "req_chat_cancel_001",
  "method": "chat.cancel",
  "params": {
    "runId": "<RUN_ID>"
  }
}
```

Expected chat event order:

```txt
run.started -> chat.delta* -> chat.completed -> run.finished
```
