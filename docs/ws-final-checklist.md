# WebSocket Final Checklist

## Startup

- `npm run gateway:ws` starts successfully.
- Server logs the WS URL.
- Server does not print token values.

## Automated Smoke

- `npm run gateway:smoke:ws` passes with the mock runtime.
- External mode passes with `GATEWAY_WS_URL=ws://127.0.0.1:8787/v1/ws`.

## Connection Security

- Missing token is rejected when `GATEWAY_WS_TOKEN` is set.
- Wrong token is rejected.
- Disallowed `Origin` is rejected.
- Empty origin remains usable for local CLI or Node clients.

## Basic Methods

- `connect`
- `ping`
- `runtime.status`
- `session.list`
- `session.create`
- `session.get`

## Chat Flow

- `chat.send` returns a `runId`.
- `run.started` is received.
- `chat.delta` is received when streaming is supported.
- `chat.completed` is received.
- `run.finished` is received.

## Cancel Flow

- Start a long-running `chat.send`.
- Send `chat.cancel` with the run ID.
- `run.cancelled` is received.
- Cancellation is not reported as `run.failed`.

## Tool Flow

- `tool.list` returns tools.
- `tool.call` can read `package.json` through the safe tool path.
- Out-of-bound file reads are denied.
- Dangerous shell commands are denied or constrained by policy.

## Memory and Audit

- `memory.search` returns results.
- `memory.write` writes through controlled memory writers.
- `audit.tail` returns recent Gateway audit entries.
- `audit.tail` redacts token, authorization, password, secret, and key data.

## Reconnect and Replay

- `connect.params.resume` accepts `sessionId` and `lastSeq`.
- Buffered events after `lastSeq` are replayed.
- Missing or expired history emits `state.resync_required`.

## Shutdown

- `Ctrl+C` triggers graceful shutdown.
- Clients receive `server.shutdown`.
- Active runs are allowed to finish until timeout.
- Remaining runs are cancelled.
- `runtime.close()` runs.
