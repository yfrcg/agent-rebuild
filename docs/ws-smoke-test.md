# WebSocket Smoke Test

The smoke script validates the basic WS path without requiring a live external model.

## Self-starting Mock Runtime

```bash
npm run gateway:smoke:ws
```

If `GATEWAY_WS_URL` is not set, the script starts a mock Gateway Runtime and a local WS server, then closes it after the test.

Expected output includes:

```txt
[ws-smoke] connect pass
[ws-smoke] runtime.status pass
[ws-smoke] session.list pass
[ws-smoke] tool.list pass
[ws-smoke] memory.search pass
[ws-smoke] chat.send pass
[ws-smoke] run.finished pass
[ws-smoke] pass
```

## External Server Mode

Terminal 1:

```bash
GATEWAY_MODEL=mock npm run gateway:ws
```

Terminal 2:

```bash
GATEWAY_WS_URL=ws://127.0.0.1:8787/v1/ws npm run gateway:smoke:ws
```

If the server requires a token:

```bash
GATEWAY_WS_TOKEN=<token> npm run gateway:smoke:ws
```

The token is appended to the URL but is not printed.

## Environment Variables

- `GATEWAY_WS_URL`: target WS URL. Defaults to a self-started local server.
- `GATEWAY_WS_TOKEN`: token for authenticated servers.
- `GATEWAY_WS_SMOKE_TIMEOUT_MS`: per-step timeout. Default `30000`.

## Common Failures

- Token missing or invalid: connection fails with 401.
- Port already in use: server startup fails.
- Model provider not configured: use `GATEWAY_MODEL=mock`.
- Session missing: rerun with `session.create` path or clear stale client state.
- Origin rejected: ensure `http://localhost:3000` is allowed or configure `GATEWAY_WS_ALLOWED_ORIGINS`.
- Rate limit triggered: wait for the window to reset or raise test limits.
