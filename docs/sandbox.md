# Sandbox

## Overview

`agent-rebuild` keeps the Windows project directory as the source of truth. Execution tools do not run directly on the Windows host by default.

```text
Windows Gateway / ToolExecutor
  -> PermissionPolicy
  -> SandboxManager
  -> WslSandboxClient
  -> WSL sandbox worker (/run)
  -> Docker runtime
  -> stdout / stderr / exitCode / timedOut / artifacts
```

This split is deliberate:

- Permission policy decides whether a tool call is allowed.
- Sandbox isolation decides where an allowed execution tool may run.
- If the worker or Docker runtime is unavailable, execution fails closed. There is no default host fallback.

## Execution Tools

The following tools are first-class execution tools:

- `run_test`
- `npm_test`
- `build`
- `shell.run`
- `bash.run`
- `sandbox.exec`

All of them are registered with `requiresSandbox: true` when they represent command execution. They flow through `ToolExecutor`, `PermissionPolicy`, and `SandboxManager`.

## Worker API

The WSL worker exposes:

- `GET /health`
- `POST /run`

### `/run` request

```json
{
  "command": "npm test",
  "cwd": "D:\\WorkStation\\agent-rebuild",
  "windowsCwd": "D:\\WorkStation\\agent-rebuild",
  "timeoutMs": 30000,
  "envAllowlist": ["CI", "NODE_ENV"],
  "workspaceMount": "D:\\WorkStation\\agent-rebuild",
  "networkPolicy": "disabled",
  "resourceLimits": {
    "memoryMb": 512,
    "cpus": 1,
    "pidsLimit": 64,
    "maxOutputBytes": 65536
  }
}
```

Supported request fields:

- `command: string`
- `cwd?: string`
- `windowsCwd?: string`
- `timeoutMs?: number`
- `envAllowlist?: string[]`
- `workspaceMount?: string`
- `networkPolicy?: "disabled" | "limited" | "enabled" | "none" | "restricted" | "host"`
- `resourceLimits?: { memoryMb?: number; cpus?: number; pidsLimit?: number; maxOutputBytes?: number }`

`windowsCwd` is kept for compatibility. The worker normalizes it into a Linux-side workspace path when running under WSL.

### `/run` response

```json
{
  "ok": true,
  "exitCode": 0,
  "stdout": "",
  "stderr": "",
  "durationMs": 812,
  "timedOut": false,
  "artifacts": []
}
```

Returned fields:

- `exitCode: number | null`
- `stdout: string`
- `stderr: string`
- `durationMs: number`
- `timedOut: boolean`
- `artifacts: Array<{ path: string; sizeBytes?: number; kind?: string; description?: string }>`

The worker can truncate large stdout/stderr bodies. The Gateway still owns final previewing and persistence into `logs/tool-results/`.

## Workspace And `cwd` Rules

The worker enforces these rules before Docker starts:

- `workspaceMount` is required.
- `workspaceMount` must exist.
- `cwd` defaults to `workspaceMount`.
- `cwd` must remain inside `workspaceMount` after normalization.
- `workspaceMount` itself must remain inside the configured worker root.
- The worker does not auto-create unknown workspaces.
- The worker does not copy the project into a second WSL directory.

This keeps Docker bound to the intended workspace instead of an arbitrary host path.

## Env Allowlist

The worker only forwards environment variables explicitly listed in `envAllowlist`.

Default minimal environment:

- `CI=true`
- `NODE_ENV=test`
- `HOME=/tmp/sandbox-home`

Sensitive keys are blocked even if present in the input env map, including:

- `SSH_AUTH_SOCK`
- `GITHUB_TOKEN`
- `GH_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN`
- `NPM_TOKEN`
- `NODE_AUTH_TOKEN`

Keys containing `KEY`, `TOKEN`, `SECRET`, or `PASSWORD` are also dropped.

## Network Policy

Current request values:

- `disabled`
- `limited`
- `enabled`

Current Docker mapping:

- `disabled` -> `--network none`
- `limited` -> currently treated as `--network none`
- `enabled` -> currently mapped to the sandbox profile's restricted Docker network behavior

`limited` is intentionally fail-closed for now. It is not silently widened to unrestricted networking.

## Resource Limits

The worker currently maps these request limits into Docker flags:

- `memoryMb` -> `--memory`
- `cpus` -> `--cpus`
- `pidsLimit` -> `--pids-limit`
- `timeoutMs` -> worker-side kill timer
- `maxOutputBytes` -> stdout/stderr truncation limit inside the worker runtime

## Artifacts

Current artifact collection is minimal and explicit:

- the worker scans `workspaceMount/artifacts`
- artifact paths must still be inside `workspaceMount`
- the worker returns metadata only
- large artifact contents are not inlined into stdout/stderr

If the directory does not exist, the worker still returns `artifacts: []`.

## Docker Runtime

The Docker backend mounts the requested workspace to `/workspace` and executes from a relative workdir inside that mount.

Current Docker flags include:

- `--rm`
- `--init`
- `--user node`
- `--read-only`
- `--tmpfs /tmp:rw,nosuid,size=256m`
- `--tmpfs /run:rw,nosuid,size=64m`
- `--security-opt no-new-privileges`
- `--cap-drop ALL`

The runtime does not mount host home, `.ssh`, `.env`, or other sensitive directories.

## Build The Sandbox Image

```bash
docker build -t agentrebuild-sandbox:latest -f packages/sandbox/Dockerfile .
```

The current Dockerfile lives at `packages/sandbox/Dockerfile`.

## Start The WSL Worker

Inside WSL:

```bash
cd /mnt/d/WorkStation/agent-rebuild
npm run sandbox:worker
```

Optional environment variables:

- `SANDBOX_PORT`
- `SANDBOX_API_KEY`
- `SANDBOX_ALLOWED_ROOT`

## Verify The Worker

From Windows:

```bash
npm run sandbox:wsl:check
```

This checks:

- `/health`
- request/response shape
- `timedOut` field presence
- `artifacts` field presence

## Run Docker Smoke Tests

```bash
npm test
```

The Docker smoke tests run when:

- Docker is available
- `agentrebuild-sandbox:latest` exists locally

If the image is missing or Docker cannot pull its base image, those smoke tests are skipped with the runtime reason.

## Why Host Fallback Is Disabled

Execution tools are not allowed to silently run on the Windows host because that would erase the security boundary:

- dangerous commands would leave the sandbox path
- workspace and env restrictions would no longer hold
- audit would no longer reflect the real execution environment

If a local development fallback is ever added later, it must remain explicit, opt-in, and disabled by default.
