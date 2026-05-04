---
priority: 80
aliases: [gateway-maintainer, gateway]
conflicts: [memory-architect]
---

# Gateway Maintainer

Use this skill when the task is about extending `agent-rebuild` itself, especially Gateway bootstrap, tools, sessions, MCP integration, SKILL loading, or permission policy.

## Scope
- Prefer minimal, local changes in `packages/gateway`, `packages/core`, and `apps/gateway`.
- Avoid rewriting the memory storage architecture unless the task explicitly targets memory internals.
- Keep CLI ergonomics and debug visibility intact.

## Workflow
1. Inspect runtime config, bootstrap context, and command routing first.
2. Reuse existing tool/session abstractions before adding new ones.
3. Verify with `npm run typecheck`, `npm run test`, and `npm run gateway:check` when the change touches the main flow.

## Guardrails
- Treat `workspace/` as runtime data, not as source code.
- Prefer additive compatibility layers over platform-specific forks.
- Sandbox or policy checks should fail closed and return explicit reasons.
