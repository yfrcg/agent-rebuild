# Sandbox v1

Build the image:

```bash
docker build -t agentrebuild-sandbox:latest -f packages/sandbox/Dockerfile .
```

Security boundary:

- Gateway itself is not sandboxed.
- v1 sandboxes tool execution only, not model inference.
- Network is denied by default.
- Host environment variables are not inherited by default.
- Only `projectRoot` is mounted to `/workspace`.
- `elevated` still requires human approval and does not bypass deny rules.
- Deny rules always take priority over ask and allow rules.
- If Docker is unavailable, sandbox execution fails closed and never falls back to host execution.
