# Agent Rebuild

> A TypeScript agent runtime inspired by OpenClaw and Claude Code, built around long-term memory, tool execution, gateway orchestration, MCP integration, and auditable development workflows.

<p align="center">
  <img src="./docs/assets/hero.png" alt="Agent Rebuild Hero" />
</p>

<p align="center">
  <b>Memory-first | Tool-using | Gateway-based | MCP-ready | Auditable</b>
</p>

<p align="center">
  <a href="package.json"><img alt="Runtime" src="https://img.shields.io/badge/runtime-Node.js%20%3E%3D%2018-339933"></a>
  <a href="#quick-start"><img alt="Language" src="https://img.shields.io/badge/language-TypeScript-3178C6"></a>
  <a href="docs/ws-protocol.md"><img alt="Transport" src="https://img.shields.io/badge/transport-REPL%20%2B%20WebSocket-4B5563"></a>
  <a href="package.json"><img alt="License" src="https://img.shields.io/badge/license-ISC-111827"></a>
</p>

Agent Rebuild is an experimental TypeScript agent runtime for local development workflows. It rebuilds the long-term memory, tool-use, context management, gateway access, and auditability patterns seen in OpenClaw and Claude Code into a Windows-friendly Node.js codebase.

It is not just a chatbot shell. The project is structured as agent infrastructure: requests can enter through a REPL, WebSocket gateway, Web UI, or client SDK; the runtime assembles context, calls models, executes tools under policy, writes transcripts and audit logs, and exposes recoverable session state.

## What is Agent Rebuild?

Agent Rebuild is a local AI Agent Gateway and runtime written in TypeScript. It combines:

- Long-term memory based on Markdown files, SQLite FTS, embeddings, and hybrid retrieval.
- A controlled tool execution layer for files, shell commands, tests, builds, Git, web fetch/search, memory, todo state, policy checks, audit queries, skills, and MCP tools.
- A Gateway Runtime that coordinates sessions, context building, model providers, tool calls, approvals, WebSocket events, and audit records.
- A React Web UI and WebSocket client package for observing and driving local agent runs.

The project is inspired by OpenClaw and Claude Code, but it is not a direct clone. The goal is to explore how those ideas can be rebuilt as a TypeScript runtime with explicit storage, policy, transport, memory, and audit boundaries.

## Why this project?

Most local agent systems become difficult to trust once they move beyond simple chat. Agent Rebuild focuses on the operational problems that appear when an agent starts reading files, running commands, remembering history, and coordinating longer development tasks.

| Problem | Agent Rebuild direction |
| --- | --- |
| Weak long-term memory makes historical context hard to recall. | Markdown-first memory, daily notes, chunking, SQLite FTS, vector search, and hybrid ranking. |
| Tool calls are often opaque and hard to debug after failure. | Structured tool registry, policy checks, result capture, audit logs, and WebSocket events. |
| Context grows quickly in real development sessions. | Layered context assembly, token budgeting, transcript compaction, and large-result truncation. |
| CLI, Web UI, WebSocket, SDK, and MCP tools need one control plane. | Gateway Runtime centralizes routing, session state, model calls, tools, and events. |
| Agent actions should be recoverable and reproducible. | JSONL audit logs, transcript persistence, session metadata, idempotency keys, and replay-oriented WS events. |

## Core Capabilities

| Area | Capability |
| --- | --- |
| Memory Core | Markdown memory, daily notes, SQLite FTS, vector search, hybrid retrieval, recency-aware ranking. |
| Gateway Runtime | REPL and WebSocket entry points, request routing, session management, runtime status, cancellation, streaming-ready events. |
| Tool System | Tool registry, schema validation, structured tool calls, file/shell/build/test/Git/web/todo/memory/audit tools. |
| MCP Integration | MCP manager, client, config loader, and adapter layer for dynamically registering external MCP tools. |
| Context Builder | Layered prompt assembly, memory retrieval, repository context, transcript compaction, token budget controls. |
| Audit & Safety | Permission policy, path guard, shell risk checks, approval tokens, tool logs, structured execution records. |
| Model Provider | OpenAI-compatible provider abstraction, MiniMax TokenPlan adapter, mock provider, streaming delta support. |
| Session Store | Transcript persistence, session recovery metadata, usage records, JSONL audit logs. |
| WebSocket API | Protocol v1.0 requests/events for chat, sessions, memory, tools, approvals, audit, MCP, and skills. |
| Web UI | React/Vite local console for sessions, chat runs, tool timelines, approvals, memory, audit, and status panels. |
| ReviewGraph | Experimental multi-agent workflow for explore, plan, implement, test, verify, security, and final review stages. |

## System Architecture

Agent Rebuild is organized around a Gateway Runtime. User requests can come from the local REPL, the React Web UI, a WebSocket client, or other future entry points. The Gateway normalizes those requests, binds them to a session, builds context, calls the selected model provider, executes approved tools, emits events, and records evidence.

The core runtime layer is split into Context Builder, Memory Core, Tool System, and MCP Manager. Supporting layers provide model access, permission policy, audit logging, session persistence, and structured storage through Markdown, SQLite, JSONL, and saved tool results.

![System Architecture](./docs/assets/architecture.png)

## Memory Pipeline

Agent Rebuild uses a Markdown-first memory pipeline:

```text
Markdown Sources -> Chunking -> Embeddings -> Hybrid Index -> Memory Search -> Context Builder
```

![Memory Pipeline](./docs/assets/memory-pipeline.png)

`workspace/MEMORY.md` and daily notes under `workspace/memory/` are the primary long-term memory sources. Memory documents are indexed into chunks with metadata, then stored in SQLite-backed tables and FTS indexes. Embeddings can be generated with DashScope or deterministic mock embeddings, depending on `EMBEDDING_PROVIDER`.

Search combines exact text evidence from SQLite FTS or LIKE fallback with semantic neighbors from vector search. Results are merged through hybrid ranking and recency adjustment before they enter the Context Builder for prompt assembly.

## Tool Execution Loop

The tool execution loop is designed to make agent actions safer, traceable, and recoverable.

```text
User Request -> Plan / Decide -> Permission Check -> Tool Call -> Result Capture -> Verify / Retry -> Final Response
```

![Tool Execution Loop](./docs/assets/tool-loop.png)

Before a tool runs, the runtime validates its schema, checks permissions, and applies path and shell safeguards. Tool results are captured as structured evidence with stdout, stderr, artifacts, errors, and audit records where applicable. Large outputs are truncated or persisted so they do not flood the prompt.

When a call fails, the agent loop can surface the real failure, retry when policy allows, or continue with captured evidence. Final responses are expected to be grounded in actual tool results rather than unsupported claims.

## Quick Start

### Requirements

- Windows 10/11 is the primary target.
- Node.js >= 18.
- MiniMax TokenPlan API key for real model calls.
- DashScope API key is optional for live embeddings.
- Tavily API key is optional for web search.

### Install

```bash
git clone https://github.com/yfrcg/agent-rebuild.git
cd agent-rebuild
npm install
copy .env.example .env
```

Set at least:

```env
GATEWAY_MODEL=tokenplan
TOKENPLAN_API_KEY=your_api_key
WINDOWS_PROJECT_ROOT=D:\WorkStation\agent-rebuild
WORKSPACE_ROOT=D:\WorkStation\agent-rebuild\workspace
GATEWAY_SANDBOX_ALLOWED_ROOTS=D:\WorkStation\agent-rebuild;D:\WorkStation\agent-rebuild\workspace
```

For offline local verification:

```env
GATEWAY_MODEL=mock
EMBEDDING_PROVIDER=mock
```

### Run the REPL Gateway

```bash
npm run gateway
```

### Run the WebSocket Gateway and Web UI

Use two terminals:

```bash
npm run gateway:ws
npm run web:dev
```

The Web UI reads `VITE_GATEWAY_WS_URL` and defaults to `/v1/ws`. For local development, set:

```env
VITE_GATEWAY_WS_URL=ws://127.0.0.1:8787/v1/ws
```

## Main Scripts

| Command | Purpose |
| --- | --- |
| `npm run gateway` | Start the local REPL Gateway. |
| `npm run gateway:ws` | Start the WebSocket Gateway. |
| `npm run web:dev` | Start the React Web UI through Vite. |
| `npm run web:build` | Type-check and build the Web UI. |
| `npm run typecheck` | Run TypeScript checks without emit. |
| `npm test` | Run the repository test suite through `scripts/run-tests.ts`. |
| `npm run reindex` | Rebuild memory indexes. |
| `npm run backfill:embeddings` | Backfill memory embeddings. |
| `npm run gateway:smoke:all` | Run Gateway smoke checks. |
| `npm run gateway:detect` | Run offline system detection. |
| `npm run gateway:check` | Run typecheck, build, tests, smoke checks, and offline detection. |
| `npm run gateway:check:live` | Run the full local check plus live system detection. |

## Project Structure

```text
agent-rebuild/
+-- apps/
|   +-- gateway/                # REPL and WebSocket startup entry points
|   +-- web-ui/                 # React local Agent Console
+-- packages/
|   +-- audit/                  # Audit log types and writer
|   +-- core/                   # Shared bootstrap, config, skills, and types
|   +-- gateway/                # Runtime, tools, policy, WS, context, ReviewGraph
|   +-- memory/                 # Memory indexing, embeddings, hybrid search, writing
|   +-- model/                  # ModelProvider abstraction and adapters
|   +-- session/                # Transcript and compaction helpers
|   +-- storage/                # SQLite storage layer
|   +-- ws-client/              # WebSocket client SDK
+-- docs/                       # WebSocket protocol, security, gateway docs, assets
+-- scripts/                    # Indexing, smoke tests, detection, eval, maintenance
+-- tests/                      # Unit, integration, WebSocket, and Gateway tests
+-- workspace/                  # Local memory, skills, user notes, and agent workspace
```

## Key Entry Points

| File | Role |
| --- | --- |
| `apps/gateway/src/main.ts` | REPL startup entry. |
| `apps/gateway/src/ws-main.ts` | WebSocket server startup entry. |
| `packages/gateway/runtime.ts` | Runtime composition root. |
| `packages/gateway/gateway.ts` | Request orchestration and Gateway handling. |
| `packages/gateway/agentRunner.ts` | Model/tool loop and DevTask execution. |
| `packages/gateway/contextBuilder.ts` | Prompt and context assembly. |
| `packages/gateway/toolCallExecutor.ts` | Tool validation, policy, execution, and result capture. |
| `packages/gateway/ws/router.ts` | WebSocket request routing. |
| `packages/memory/src/hybridSearch.ts` | FTS/vector hybrid retrieval. |
| `apps/web-ui/src/App.tsx` | Web UI shell. |

## Tool System

Built-in tools are registered through `packages/gateway/builtinTools.ts` and executed through `ToolCallExecutor`.

| Group | Examples |
| --- | --- |
| File | `file.read`, `file.write`, `file.edit`, `file.list`, `file.glob`, `file.grep`, `file.multi_edit`, `file.patch` |
| Shell | `shell.run`, `bash.run`, `npm_test`, `build`, `run_test` |
| Development | `typecheck.run`, `lint.run`, `verify.run` |
| Git | `git.status`, `git.diff`, `git.commit` |
| Repository | `repo.map`, `repo.symbols`, `repo.deps` |
| Web | `web.fetch`, `web.search` |
| Todo | `todo.write`, `todo.update`, `todo.list` |
| Agent / Audit | `agent.verify`, `policy.check`, `audit.query` |
| Memory | `memory.search`, `memory.write` |
| Skills / MCP | `skill`, plus dynamically registered `mcp.*` tools |

Tool execution is guarded by schema validation, workspace path policy, command risk checks, approval policy, output truncation, and audit recording.

## WebSocket API

Protocol version: `1.0`.

Common request methods:

```text
connect
ping
runtime.status
runtime.updateConfig
session.list
session.get
session.create
session.rename
session.delete
session.purge
session.bindProject
session.getTranscript
chat.send
chat.cancel
memory.search
memory.write
mcp.status
mcp.tools
mcp.config.add
skills.list
skills.current
skills.use
skills.clear
tool.list
tool.call
approval.list
approval.confirm
approval.reject
audit.tail
```

Common server events:

```text
connected
heartbeat
run.started
run.progress
chat.delta
chat.completed
tool.started
tool.finished
tool.failed
tool.denied
approval.required
session.updated
audit.append
run.finished
run.failed
run.cancelled
state.resync_required
server.shutdown
```

See:

- [WebSocket Protocol](docs/ws-protocol.md)
- [WebSocket Gateway](docs/ws-gateway.md)
- [WebSocket Security](docs/ws-security.md)
- [Final Checklist](docs/ws-final-checklist.md)

## Configuration

| Variable | Default / Example | Purpose |
| --- | --- | --- |
| `GATEWAY_MODEL` | `tokenplan` / `mock` | Active model provider. |
| `TOKENPLAN_API_KEY` | empty | MiniMax TokenPlan API key. |
| `TOKENPLAN_MODEL` | `codex-MiniMax-M2.7` | TokenPlan model name. |
| `WORKSPACE_ROOT` | `...\workspace` | Local memory and workspace root. |
| `GATEWAY_SANDBOX_ALLOWED_ROOTS` | project root and workspace | Allowed local read/write roots. |
| `GATEWAY_AUTO_TOOL_LOOP_ENABLED` | `true` | Enable automatic model-driven tool loop. |
| `GATEWAY_AUTO_REVIEW_GRAPH_ENABLED` | `false` | Enable experimental ReviewGraph workflow. |
| `GATEWAY_WS_HOST` | `127.0.0.1` | WebSocket server host. |
| `GATEWAY_WS_PORT` | `8787` | WebSocket server port. |
| `GATEWAY_WS_TOKEN` | empty | WebSocket auth token. |
| `EMBEDDING_PROVIDER` | `mock` | `mock` or `dashscope` embeddings. |
| `DASHSCOPE_API_KEY` | empty | DashScope embedding API key. |
| `TAVILY_API_KEY` | empty | Tavily web search API key. |

See [.env.example](.env.example) for the full list.

## Quality Checks

For core runtime changes:

```bash
npm run typecheck
npm test
npm run gateway:smoke:all
npm run gateway:detect
```

For Web UI changes:

```bash
npm run web:build
```

For a full local validation pass:

```bash
npm run gateway:check
```

## Roadmap

| Status | Direction |
| --- | --- |
| WIP | Stronger repository indexing, module summaries, and codebase retrieval. |
| WIP | More complete Web UI diagnostics for runs, approvals, memory, and tool timelines. |
| WIP | Better token, cost, latency, cache-hit, and failure observability. |
| Experimental | ReviewGraph multi-agent workflow for development tasks. |
| Experimental | MCP tool discovery and runtime registration across external tool servers. |
| Roadmap | Recoverable event streams for long-running tasks and multi-client state synchronization. |
| Roadmap | Finer-grained permission policies, approval UX, and safety profiles. |

Production-oriented design notes are tracked in [PRODUCTION_ARCHITECTURE.md](PRODUCTION_ARCHITECTURE.md).

## Tech Stack

| Layer | Stack |
| --- | --- |
| Runtime | Node.js, TypeScript, tsx |
| Gateway transport | REPL, WebSocket (`ws`) |
| Frontend | React 19, Vite 6, Zustand, react-markdown |
| Storage | SQLite via `better-sqlite3`, JSONL logs, Markdown files |
| Memory | SQLite FTS, vector search, DashScope or mock embeddings |
| Model access | OpenAI-compatible provider, MiniMax TokenPlan adapter, mock provider |
| Tooling | TypeScript compiler, Node test runner, smoke/detection scripts |
| External integrations | MCP SDK, Tavily web search, DashScope embeddings |

## Learning Notes

The codebase still includes learning-oriented comments and a small local skill under `workspace/skills/gateway-maintainer`. They are useful when studying the runtime path from `runtime.ts` to `gateway.ts`, `contextBuilder.ts`, `agentRunner.ts`, `toolCallExecutor.ts`, and `hybridSearch.ts`, but the README now treats the project as an open-source runtime rather than a course report.

## License

ISC
