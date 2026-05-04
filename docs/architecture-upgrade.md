# Architecture Upgrade Notes

## Scope

This upgrade converts `agent-rebuild` to a Windows-only local execution architecture. All WSL/Docker sandbox execution dependencies have been removed.

```text
Windows Project Directory
  -> Windows Gateway / Agent Core
  -> ToolExecutor / PermissionPolicy / Memory / Session / Audit
  -> LocalCommandRunner
  -> Windows child_process (PowerShell) execution
  -> stdout / stderr / exitCode / timedOut
```

## What Changed

- **Desandboxing**: removed all WSL sandbox worker, Docker backend, and SandboxClient dependencies from the execution path.
- Execution tools (`shell.run`, `bash.run`, `run_test`, `npm_test`, `build`) now run locally via `LocalCommandRunner` using `child_process.spawn` with PowerShell.
- `GatewaySandbox` is now a pure policy guard (no sandbox manager, no container config).
- Shared utilities (`createToolSecurityProfile`, `assertInsideWorkspace`, `isDangerousHostPath`) moved from `packages/sandbox/src/` into `packages/gateway/` as local modules.
- Deleted sandbox scripts: `sandbox-check.ts`, `sandbox-smoke.ts`, `sandbox-worker.ts`, `sandbox-wsl-check.ts`, `sandbox-runtime-check.ts`.
- Deleted sandbox tests: `sandbox.test.ts`, `sandboxClient.test.ts`, `sandboxDockerRuntime.test.ts`, `sandboxManager.test.ts`, `sandboxWorkerServer.test.ts`.
- Removed `package.json` sandbox scripts: `sandbox:check`, `sandbox:smoke`, `sandbox:wsl:check`, `sandbox:worker`, `sandbox:image:build`, `sandbox:runtime:check`.
- Removed `config.sandbox` (SandboxConfig) from `GatewayRuntimeConfig`.
- Removed `SandboxManager` instantiation from `apps/gateway/src/main.ts`.
- Tool protocol retains `requiresSandbox: false` for backward compatibility.

## What Did Not Change

- Agent Loop, Tool Call Protocol, ToolRegistry, ToolExecutor
- PermissionPolicy (plan mode blocks, cwd restriction, dangerous command interception)
- read-before-edit / mtime anti-overwrite
- Audit log
- Memory (search, get, write)
- Session management
- Context builder
- logs/tool-results output truncation
- MCP, skills support

## Execution Tools

All execution tools are registered with:

- `permissionLevel: execute`
- `readOnly: false`
- `sideEffect: true`
- `requiresSandbox: false`
- `allowHostExecution: true`
- `runner: local-windows`

Default behavior:

- `shell.run`: runs command via PowerShell locally.
- `bash.run`: maps to PowerShell on Windows (no WSL/bash required).
- `run_test`: runs explicit command, or `npm test` when none provided.
- `npm_test`: runs `npm test` by default, or `npm run <script>`.
- `build`: runs explicit command, or `npm run build` if `package.json` has `scripts.build`.

## LocalCommandRunner

`packages/gateway/localCommandRunner.ts` executes commands locally:

- Uses `child_process.spawn` with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`.
- `cwd` must be inside the Windows workspace (path.win32 normalization).
- `timeoutMs` enforced via kill timer (default 120s).
- `stdout` truncated at 256KB, `stderr` at 128KB.
- Sensitive env vars (TOKEN, SECRET, API_KEY, PASSWORD, CREDENTIAL) filtered.
- Returns `{ exitCode, stdout, stderr, durationMs, timedOut }`.

## Security Boundary

Local execution is NOT a strong security sandbox. The following protections remain:

- **PermissionPolicy**: plan mode blocks execution tools; dangerous commands rejected.
- **cwd restriction**: commands cannot execute outside workspace.
- **Path guard**: `.env`, `.ssh`, credential paths blocked (Windows-aware).
- **Audit log**: every tool call logged with `runner: "local-windows"`.
- **Output truncation**: large outputs written to `logs/tool-results/`.
- **Env filtering**: sensitive tokens/keys not passed to child processes.

## GatewaySandbox (Policy Guard)

`packages/gateway/sandbox.ts` is now a pure policy guard:

- No `SandboxManager` dependency.
- No `containerConfig` or Docker/WSL references.
- Provides: `canExecuteTool`, `canUseToolInputPaths`, `canWriteMemory`, `requiresConfirmation`, `canConnectMcpServer`.
- Used by Gateway, ToolCallExecutor, replCommandHandlers, mcpManager for policy enforcement.

## Deprecated Modules

The following packages have been deleted:

- `packages/sandbox/` - WSL/Docker sandbox runtime (deleted)
- `packages/sandbox-client/` - SandboxClient (deleted)

Old sandbox documentation archived to `logs/archive/old-logs/`.

## Running

```text
npm run typecheck
npm test
npm run gateway:smoke:all
npm run gateway:detect
```

No longer needed:

```text
npm run sandbox:worker
npm run sandbox:image:build
npm run sandbox:runtime:check
npm run sandbox:check
npm run sandbox:smoke
npm run sandbox:wsl:check
```

## Current Limits

- Plan mode is session state + approval workflow, not a full autonomous planner.
- Local execution provides workspace isolation, not OS-level sandboxing.
- `bash.run` on Windows maps to PowerShell; native bash commands may need adaptation.
