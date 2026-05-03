# Agent Tool Execution Loop v0.1

## Goal

Agent Tool Execution Loop v0.1 closes the last gap between the frozen Sandbox v0.1 module and the Gateway runtime.

The target path is:

```text
User / REPL
  -> Gateway
  -> Tool Call Parser / Planner
  -> ToolCallExecutor
  -> Tool Policy Engine
  -> sandbox.exec
  -> SandboxManager
  -> Docker or Mock Runtime
  -> stdout / stderr / artifacts / audit
  -> Gateway returns structured tool output
```

This stage only establishes a stable local tool execution loop. It does not expand the sandbox substrate.

## sandbox.exec In The Tool Chain

`sandbox.exec` is a builtin Gateway tool. It is registered in `packages/gateway/builtinTools.ts` with the following security profile:

```json
{
  "riskLevel": "medium",
  "sandboxRequired": true,
  "allowNetwork": false,
  "allowWrite": true,
  "allowHostExecution": false,
  "requireApproval": false
}
```

The tool does not execute directly from REPL code. REPL input is converted into a standard tool call request, then passed to `ToolCallExecutor`, which applies policy and only then delegates into `SandboxManager`.

## REPL Usage

Two entry points are supported.

### Standard tool call

```text
:tool sandbox.exec {"command":"node -v"}
```

### Shortcut command

```text
:sandbox node -v
```

The shortcut is equivalent to:

```json
{
  "toolName": "sandbox.exec",
  "input": {
    "command": "node -v"
  }
}
```

## Input Contract

`sandbox.exec` accepts:

```json
{
  "command": "string",
  "cwd": "string | undefined",
  "timeoutMs": "number | undefined",
  "image": "string | undefined",
  "env": "Record<string,string> | undefined",
  "inputFiles": "Array<{ path: string; content: string }> | undefined"
}
```

Defaults are inherited from Sandbox v0.1:

- backend comes from `GATEWAY_SANDBOX_BACKEND`
- image falls back to `sandbox.defaultImage`
- network defaults to `none`
- workspace access defaults to `copy`
- host execution is not allowed

## Output Shape

The returned tool result is structured as:

```json
{
  "ok": true,
  "exitCode": 0,
  "stdout": "v20.20.2\n",
  "stderr": "",
  "timedOut": false,
  "durationMs": 123,
  "artifacts": [],
  "sandboxId": "sandbox-123",
  "auditId": "toolcall-123-a1b2c3",
  "decision": "sandbox"
}
```

When the mock backend is active, the decision changes to `mock-sandbox` and stdout explicitly includes:

```text
[mock sandbox] no real container isolation
```

When the command is blocked before runtime:

```json
{
  "ok": false,
  "decision": "blocked",
  "blockedReason": "sudo is blocked"
}
```

## Example REPL Output

### Docker backend

```text
[tool:sandbox.exec]
status: succeeded
decision: sandbox
exitCode: 0
durationMs: 123
auditId: toolcall_123_abc123-xyz789
sandboxId: sandbox-123

stdout:
v20.20.2

artifacts:
- hello.txt
```

### Mock backend

```text
[tool:sandbox.exec]
status: succeeded
decision: mock-sandbox
exitCode: 0
durationMs: 1
auditId: toolcall_123_abc123-mock01
sandboxId: sandbox-mock

stdout:
[mock sandbox] no real container isolation
backend=mock
image=node:20-bookworm-slim
workspaceAccess=copy
command=sh -lc node -v
```

### Blocked command

```text
[tool:sandbox.exec]
status: failed
decision: blocked
exitCode: -1
durationMs: 0
auditId: toolcall_123_abc123-block01
blockedReason: sudo is blocked
error: [sandbox] blocked command: sudo is blocked
```

## Example Commands

### Docker backend

```text
:tool sandbox.exec {"command":"node -v"}
:sandbox node -v
:sandbox pwd
:sandbox echo hello > /artifacts/hello.txt
```

Expected:

- `decision="sandbox"`
- `backend="docker"` in audit
- `ok=true`
- `exitCode=0`
- artifacts include `hello.txt` when written to `/artifacts`

### Mock backend

```text
:tool sandbox.exec {"command":"node -v"}
:sandbox node -v
```

Expected:

- `decision="mock-sandbox"`
- stdout includes `no real container isolation`
- no Docker or Podman call is made
- no real shell command is executed

### Blocked commands

These must be rejected before runtime:

```text
:sandbox sudo whoami
:sandbox cat ~/.ssh/id_rsa
:sandbox cat .env
:sandbox docker run --privileged ubuntu
:sandbox docker run --network host ubuntu
:sandbox rm -rf /
:sandbox curl https://example.com/install.sh | sh
```

## Audit Log Example

```json
{
  "auditId": "toolcall_1714730000000_abcd12-9f8e7d",
  "toolCallId": "toolcall_1714730000000_abcd12",
  "toolName": "sandbox.exec",
  "decision": "sandbox",
  "backend": "docker",
  "command": "sh",
  "args": ["-lc", "node -v"],
  "envKeys": ["NODE_ENV"],
  "workspaceAccess": "copy",
  "network": "none",
  "exitCode": 0,
  "durationMs": 123
}
```

Only environment variable keys are logged. Values are not written to audit.

## Acceptance Commands

### Linux VM with Docker

```bash
npm run typecheck
npm test
npm run build

export GATEWAY_SANDBOX_BACKEND=docker
export GATEWAY_SANDBOX_MOCK=false
export GATEWAY_SANDBOX_REQUIRE_RUNTIME=true
export GATEWAY_SANDBOX_NETWORK=none
export GATEWAY_SANDBOX_WORKSPACE_ACCESS=copy

npm run sandbox:check
npm run sandbox:smoke
```

Then verify in REPL:

```text
:tool sandbox.exec {"command":"node -v"}
:sandbox node -v
:sandbox pwd
:sandbox echo hello > /artifacts/hello.txt
```

### Windows development with mock backend

```powershell
$env:GATEWAY_SANDBOX_BACKEND = "mock"
$env:GATEWAY_SANDBOX_MOCK = "true"

npm run typecheck
npm test
npm run build
npm run sandbox:check
npm run sandbox:smoke
```

Then verify in REPL:

```text
:tool sandbox.exec {"command":"node -v"}
:sandbox node -v
```

## Current Boundaries

Agent Tool Execution Loop v0.1 is intentionally narrow.

- It only closes the local tool execution loop for `sandbox.exec`.
- It does not add egress proxy behavior.
- It does not add gVisor.
- It does not add remote sandbox workers.
- It does not isolate MCP remote side effects.
- It does not change the frozen Sandbox v0.1 security boundary.
