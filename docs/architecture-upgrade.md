# Architecture Upgrade Notes

## Scope

This upgrade moves `agent-rebuild` closer to a Claude Code style agent core without changing the project's core deployment shape:

```text
Windows project directory
  -> Windows Gateway / Agent Core
  -> agent loop / tool registry / permission policy / memory / session / audit
  -> WSL sandbox worker
  -> Docker or restricted Linux execution
  -> stdout / stderr / exitCode / artifacts back to Gateway
```

The reference project `claude-code-from-scratch` was used only as an architectural reference. This repo does not copy its file layout or replace the existing memory stack.

## What Changed

- Added a richer tool protocol:
  - `permissionLevel`
  - `readOnly`
  - `sideEffect`
  - `requiresSandbox`
  - `timeoutMs`
- Added a Gateway permission layer separate from sandbox isolation:
  - `default`
  - `plan`
  - `acceptEdits`
  - `dontAsk`
  - `bypassPermissions`
- Added read-before-edit protection with mtime/hash checks.
- Added session-level plan mode state and REPL commands:
  - `:plan on`
  - `:plan off`
  - `:plan show`
  - `:plan approve`
  - `:plan reject`
  - `:plan execute_with_context`
  - `:plan execute_fresh`
- Extended context building so the model sees permission mode and plan state.
- Added tool-result truncation to `logs/tool-results/` for oversized outputs.
- Added first-class execution tools:
  - `run_test`
  - `npm_test`
  - `build`
- Added lightweight memory rule-layer enhancements:
  - memory category classification: `user | feedback | project | reference`
  - freshness metadata on retrieved memory

## What Did Not Change

- Primary memory retrieval is still hybrid:
  - Markdown memory sources
  - chunking
  - SQLite FTS / BM25
  - vector search
  - hybrid fusion
- Shell/test/build execution is still expected to go through sandbox boundaries.
- The Windows project directory remains the source of truth.
- MCP, skills, and sub-agent support remain incremental extensions instead of a rewrite.

## Permission Gate vs Sandbox

- Permission policy decides whether a tool call should be allowed at all.
- Sandbox isolation decides where an allowed execution tool may run.

They are intentionally separate:

- A command can be denied before sandbox execution because it is dangerous.
- A command can be permission-allowed but still denied because no sandbox is available.

## Execution Tools

`run_test`, `npm_test`, and `build` are registered as execution tools with:

- `permissionLevel: execute`
- `readOnly: false`
- `sideEffect: true`
- `requiresSandbox: true`

They are semantic wrappers around the existing sandboxed command path. They do not execute on the Windows host by default.

Default behavior:

- `run_test`: runs an explicit test command, or `npm test` when no command is provided.
- `npm_test`: runs `npm test` by default, or `npm run <script>` when `script` is provided.
- `build`: runs an explicit command when provided; otherwise it looks for a local `package.json` build script and runs `npm run build`.

## Host Fallback

Execution tools do not silently fall back to the Windows host when:

- the WSL sandbox worker is down
- sandbox configuration is missing
- the remote sandbox request fails
- the Docker image is unavailable behind the worker

Instead, the Gateway returns a clear denial or execution error. This keeps the safety boundary explicit and prevents accidental host execution.

If a local development fallback is added later, it must remain opt-in and disabled by default.

## Running The Sandbox

Start the WSL sandbox worker first, then run the Gateway from Windows:

```text
WSL:
cd /mnt/d/WorkStation/agent-rebuild
npm run sandbox:worker

Windows:
cd D:\WorkStation\agent-rebuild
npm run gateway
```

Typical execution-tool calls then flow through the worker:

- `:tool run_test {"command":"npm test"}`
- `:tool npm_test {}`
- `:tool build {}`

Large stdout/stderr payloads are summarized in context and written to `logs/tool-results/`.

## WSL Worker Contract

The Gateway now sends execution requests through `WslSandboxClient` using a stable `/run` contract:

```json
{
  "command": "npm test",
  "cwd": "D:\\WorkStation\\agent-rebuild",
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

The worker responds with:

```json
{
  "exitCode": 0,
  "stdout": "",
  "stderr": "",
  "durationMs": 500,
  "timedOut": false,
  "artifacts": []
}
```

Current worker-side guarantees:

- `workspaceMount` is required and must exist.
- `cwd` defaults to `workspaceMount`.
- `cwd` must remain inside `workspaceMount`.
- env passthrough is filtered by `envAllowlist`.
- `disabled` and `limited` network modes fail closed instead of widening access.
- Docker limits are mapped from `resourceLimits`.
- `timedOut` and `artifacts` are always present in the execution response shape.

The corresponding Windows-side check is:

```text
npm run sandbox:wsl:check
```

The Docker image used by the runtime can be built with:

```text
docker build -t agentrebuild-sandbox:latest -f packages/sandbox/Dockerfile .
```

## Current Limits

- Plan mode is implemented as a session state and approval workflow, not a full autonomous planner/executor chain.
- Memory metadata enhancement is currently rule-layer only. It does not replace the underlying storage schema.
- Docker runtime smoke tests are environment-sensitive and skip when the sandbox image is unavailable.
- `networkPolicy=limited` is currently implemented as fail-closed Docker networking instead of a fine-grained egress policy.
- Artifact collection currently scans `workspace/artifacts` and returns metadata only. It is not yet an upload pipeline.
