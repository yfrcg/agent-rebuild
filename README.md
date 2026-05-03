# agent-rebuild

复现一个面向本地工作区的 Agent / Gateway 工程，当前基于 Node.js + TypeScript + SQLite。

项目现阶段有两条主线：

- Memory Core：本地记忆写入、索引、混合检索、压缩与恢复
- Gateway：CLI REPL、模型调用、防护与审计、Session、Tool Registry、MCP Adapter

## 当前进度

### Memory Core

已完成：

- 三级记忆体系
  - `workspace/sessions/*.jsonl`
  - `workspace/MEMORY.md`
  - `workspace/memory/YYYY-MM-DD.md`
- SQLite 存储与索引
  - `mem_files`
  - `mem_docs`
  - `mem_fts`
  - `mem_embeddings`
- hybrid search
  - FTS + vector search
  - RRF 融合排序
- memory write / read
- compaction
  - `flush`
  - `recover`
- scheduler / reindex / backfill embeddings

### Gateway

已完成：

- Gateway v0.1
  - CLI REPL 主入口
  - Gateway 主链路
  - `memory.search`
  - `ContextBuilder`
  - `ModelProvider / MockModelProvider / DeepSeekProvider`
  - `FileAuditLogger`
  - `RateLimiter`
  - `CircuitBreaker`
  - `MetricsCollector`
  - `system-detect` 准入
- Gateway v0.2
  - 最小 Session Management
  - CLI 多会话
  - `:session / :session current / :session list / :session new [name] / :session switch <sessionId> / :session rename <name>`
- Gateway v0.3
  - 内部 Tool Registry
  - `toolTypes.ts / toolRegistry.ts / builtinTools.ts`
  - 当前内置工具：`memory.search`
- Gateway v0.4
  - Tool Call Protocol
  - `toolCallTypes.ts / toolCallFactory.ts / toolCallExecutor.ts / toolCallPrinter.ts`
  - `:tool` 通过 `ToolCallExecutor` 执行
  - tool call audit
- Gateway v0.5
  - MCP Adapter
  - 支持通过官方 MCP TypeScript SDK 连接外部 stdio MCP Server
  - 动态发现外部 MCP tools
  - 将 MCP tools 映射并注册到现有 `ToolRegistry`
  - 通过现有 `:tool` 手动调用 MCP tool
- Gateway v0.6
  - 受控自动工具调用
  - 仅自动使用 `memory.search` 与 `mcp.*`
  - 单轮最多执行有限步数工具，再回到模型作答
  - 自动工具调用复用现有 `ToolCallExecutor` 与 audit 语义
- Gateway v0.6.1
  - 自动工具调用 explainability
  - decision trace / available tools / finish reason 调试信息
  - `gateway:eval:auto-tool` 评测脚本
- Gateway v0.7
  - 工具策略分层
  - `auto / confirm / manual` 自动化等级
  - `read-only / external-read / stateful / destructive` 风险等级
  - MCP tools 基于名称和描述做安全策略推断
- Gateway v0.8
  - 记忆检索 recentness 加权
  - session compaction 结构化摘要
  - memory selection explainability
- Gateway v0.8.1
  - 兼容多平台目录约定的 `SKILL.md` 发现机制
  - `:skills / :skills show <name>` 技能查看命令
  - 初版 sandbox，拦截记忆写入和高风险工具执行
- Gateway v0.9
  - Windows 主项目 + WSL Sandbox Worker + Docker 沙箱链路完成
  - Windows Gateway 在 `SANDBOX_MODE=wsl` 下通过 HTTP 调用 `http://127.0.0.1:8765/run`
  - WSL worker 将 `D:\WorkStation\agent-rebuild` 映射为 `/mnt/d/WorkStation/agent-rebuild`
  - Docker 容器挂载 `/mnt/d/WorkStation/agent-rebuild:/workspace`
  - `bash.run / file.read / file.write / file.edit` 统一走沙箱执行
  - `npm run sandbox:wsl:check` 可检查 `health + node -v` 端到端链路
  - 自然语言 `帮我运行 node -v` 已可自动触发 `bash.run`
  - 当前可标记为 `sandbox v0.1 complete`

## 当前边界

当前明确不做：

- 多 Agent
- WebSocket
- 前端 UI
- 插件市场
- 复杂权限 / RBAC
- 开放式模型自动工具编排
- Agent planner

说明：

- `v0.6` 已支持“受控自动工具调用”
- 当前仍不做开放式 agent planner、长期自主循环或多 Agent 编排

`packages/memory` 的架构、SQLite 表结构、索引流程、embedding 流程、hybrid search 设计在 Gateway v0.5 中没有改动。

## Sandbox 架构

当前沙箱阶段采用“Windows 主项目 + WSL 外接执行服务”的结构：

```text
Windows:
D:\WorkStation\agent-rebuild
    ↓
Windows Gateway / Agent
    ↓ HTTP
http://127.0.0.1:8765/run
    ↓
WSL Sandbox Worker
    ↓
Docker / Linux Sandbox
    ↓
/mnt/d/WorkStation/agent-rebuild -> /workspace
```

约束：

- 主项目代码只维护在 Windows：`D:\WorkStation\agent-rebuild`
- WSL 中只运行独立的 `~/sandbox-worker`
- Windows Gateway 不直接执行危险 shell 命令
- 命令执行结果统一返回 `stdout / stderr / exitCode / durationMs`
- WSL worker 审计日志写入 `~/sandbox-worker/logs/sandbox-audit.jsonl`

## 目录结构

```text
apps/gateway/src/
  main.ts

packages/
  audit/
  core/
  gateway/
  memory/
  model/
  session/
  storage/

config/
  mcp.servers.example.json

scripts/
  reindex.ts
  backfill-embeddings.ts
  scheduler.ts
  smoke-gateway.ts
  smoke-gateway-all.ts
  system-detect.ts

workspace/
  AGENTS.md
  SOUL.md
  USER.md
  TOOLS.md
  MEMORY.md
  DREAMS.md
  skills/
  memory/
  sessions/
```

## 安装

要求：

- Node.js 18+
- npm 9+

安装依赖：

```bash
npm install
```

## 常用命令

```bash
npm run dev
npm run gateway
npm run build
npm run typecheck
npm run test
npm run gateway:check
npm run gateway:check:live
npm run gateway:eval:auto-tool
npm run sandbox:wsl:check

npm run reindex
npm run backfill:embeddings
npm run scheduler
```

说明：

- `npm run gateway`：启动 Gateway CLI
- `npm run gateway:check`：执行离线门禁：`typecheck + build + test + smoke + offline-detect`
- `npm run gateway:check:live`：在离线门禁基础上追加真实 API 联通验证
- `npm run gateway:eval:auto-tool`：运行自动工具调用评测脚本
- `npm run sandbox:wsl:check`：检查 WSL worker `health` 并通过沙箱执行 `node -v`

### WSL worker 启动

```bash
# WSL
cd ~/sandbox-worker
npm run dev

# Windows
cd D:\WorkStation\agent-rebuild
npm run dev
```

## Gateway CLI

### 基础命令

```text
记住：<内容>
查记忆 <关键词>
读文件 <相对路径>
flush
recover
compact
help
exit
```

### Session 命令

```text
:session
:session current
:session list
:session new [name]
:session switch <sessionId>
:session rename <name>
```

### Tool 命令

```text
:skills
:skills show <name>
:skills use <name>
:skills current
:skills clear
:tools
:tool <name> <json>
:sh <command>
:sandbox <command>
:confirm <token>
:reject <token>
```

### 开发 / 离线验证

```text
GATEWAY_MODEL=mock
EMBEDDING_PROVIDER=mock
```

说明：

- `GATEWAY_MODEL=mock`：使用离线 mock 模型提供商
- `EMBEDDING_PROVIDER=mock`：使用离线 deterministic embedding
- `GATEWAY_AUTO_TOOL_LOOP_ENABLED=true`：开启受控自动工具调用
- `GATEWAY_AUTO_TOOL_LOOP_MAX_STEPS=3`：限制单轮自动工具步数
- `SANDBOX_MODE=wsl`：启用 WSL 外接沙箱后端
- `SANDBOX_API_URL=http://127.0.0.1:8765`：WSL worker HTTP 地址
- `SANDBOX_API_KEY=...`：Windows Gateway 与 WSL worker 共享的 Bearer key
- `WINDOWS_PROJECT_ROOT=D:\WorkStation\agent-rebuild`：Windows 主项目根目录
- `GATEWAY_SANDBOX_MODE=workspace-write|read-only|off`：设置 sandbox 模式
- `GATEWAY_SANDBOX_ALLOWED_ROOTS=workspace,config`：额外设置 sandbox 允许的路径根
- `GATEWAY_SESSION_AUTO_COMPACT_ENABLED=true`：开启 transcript 自动压缩
- `GATEWAY_SESSION_AUTO_COMPACT_MAX_ENTRIES=80`：超过该条数后自动 compact
- `GATEWAY_EVAL_CASES_PATH=...`：指定自动工具调用评测用例文件

示例：

```text
:tool memory.search {"query":"Gateway v0.4","topK":5}
:tool bash.run {"command":"node -v"}
:sh node -v
```

### MCP 命令

```text
:mcp
:mcp status
:mcp tools
```

说明：

- `:mcp / :mcp status`：查看 MCP Server 状态
- `:mcp tools`：查看已发现并映射的 MCP tools
- `:skills`：列出已发现的兼容 `SKILL.md`
- `:skills show <name>`：查看某个技能的完整内容
- `:skills use <name>`：为当前 session 显式启用一个技能
- `:skills current`：查看当前 session 已启用技能
- `:skills clear`：清空当前 session 已启用技能
- `use skill <name>`：自然语言别名，等价于 `:skills use <name>`
- `:tools`：列出全部已注册工具，包括内置工具和 MCP tools
- `:tool`：通过现有 Tool Call Protocol 手动调用工具
- `:confirm <token>`：执行一条已排队的高风险工具调用

### 自动工具调用（v0.6）

- 普通聊天请求会先进入“是否需要工具”的决策阶段
- 当前自动可用工具仅限：
  - `memory.search`
  - `mcp.*`
  - `bash.run`
  - `file.read`
- 每次请求最多执行 `GATEWAY_AUTO_TOOL_LOOP_MAX_STEPS` 次工具调用
- 自动工具调用仍复用现有 `ToolCallExecutor`，因此会保留统一 audit 和 transcript 轨迹
- 若规划输出非法、工具失败或到达步数上限，Gateway 会退回正常文本回答，不让主流程崩溃
- 对“帮我运行 … / 运行 … / 执行 …”这类明确 shell 请求，Gateway 会优先直接落到 `bash.run`

### 工具策略分层（v0.7）

- 每个工具都可携带 policy 元数据：
  - `automationLevel`
  - `riskLevel`
- 当前约定：
  - `auto`：可被自动工具循环直接调用
  - `confirm`：需要先征得用户确认
  - `manual`：只能显式 `:tool`
- builtin `memory.search` 默认是 `auto + read-only`
- MCP tools 会根据名称和描述推断策略：
  - `search/list/get/read/fetch/query/find` 倾向于 `auto`
  - `open/run/execute/trigger/deploy` 倾向于 `confirm`
  - `create/update/delete/write/remove/mutate` 倾向于 `manual`

### Memory / Session 质量（v0.8）

- hybrid search 在融合排序后会再加一层 recentness boost，更偏向最近 1 到 30 天的 daily memory
- session compaction 不再直接把原始 transcript 拼接写回记忆，而是先做启发式结构化摘要
- debug 信息里会额外暴露：
  - memory source breakdown
  - top memory ids
  - hasRecentMemory

### SKILL 机制（v0.8.1）

- Gateway 会扫描以下兼容目录中的 `SKILL.md`
  - `workspace/skills/**/SKILL.md`
  - `skills/**/SKILL.md`
  - `.codex/skills/**/SKILL.md`
  - `.trae/skills/**/SKILL.md`
  - `.claude/skills/**/SKILL.md`
- 启动时会把技能清单注入 bootstrap context
- 当用户显式提到技能名，Gateway 会把匹配的 `SKILL.md` 正文按需注入上下文，而不是一次性加载全部技能
- `SKILL.md` 可选支持简易 frontmatter：
  - `priority: 80`
  - `aliases: [foo, bar]`
  - `conflicts: [other-skill]`
- 当多个技能同时命中时，会优先选更高 `priority` 的技能，并跳过冲突技能

### 初版 Sandbox（v0.8.1）

- `workspace-write`：
  - 允许本地 workspace 记忆写入
  - 允许 `read-only / external-read` 工具
  - 阻止 `stateful / destructive` 工具
- `read-only`：
  - 阻止 `remember / flush / compact`
  - 阻止 `stateful / destructive` 工具
- `off`：
  - 不做 sandbox 拦截
- 所有非 `off` 模式都会检查工具输入中的路径字段（如 `path/file/cwd/root/workspace`）
  - 若绝对路径不在允许根目录内，则直接拒绝执行
  - `confirm` / `manual` / `destructive` 工具在 `:tool` 路径上会生成一次性确认 token，需显式 `:confirm <token>`
- MCP stdio 子进程支持 best-effort 隔离配置：
  - 私有 `HOME / USERPROFILE / TMP / TEMP`
  - 可裁剪继承环境变量
  - 独立运行时目录 `workspace/sandbox/mcp/<serverId>`

### WSL + Docker Sandbox（v0.9）

- `SANDBOX_MODE=wsl` 时，Gateway 使用 remote backend，而不是本地 `child_process` 直接执行危险命令
- 执行链路为：
  - `ToolCallExecutor`
  - `SandboxManager`
  - `WslSandboxBackend`
  - `WslSandboxClient`
  - `POST /run`
  - WSL worker
  - Docker `node:20`
- WSL worker 负责：
  - Bearer token 校验
  - Windows 路径转 WSL 路径
  - 根目录约束：只允许 `/mnt/d/WorkStation/agent-rebuild`
  - 危险命令拦截
  - timeout / output 限制
  - Docker 挂载 `/mnt/d/WorkStation/agent-rebuild:/workspace`
  - audit log 记录
- 已验证：
  - `npm run sandbox:wsl:check`
  - `:sh node -v`
  - 自然语言 `帮我运行 node -v`

## MCP Adapter

Gateway v0.5 当前只支持：

- `stdio` transport

使用的 SDK：

- `@modelcontextprotocol/sdk`

### 配置文件

真实配置文件：

- `config/mcp.servers.json`

示例配置文件：

- `config/mcp.servers.example.json`

如果 `config/mcp.servers.json` 不存在：

- Gateway 仍可正常启动
- `:mcp status` 会提示未配置 MCP servers

### 示例配置

```json
{
  "servers": [
    {
      "id": "course_project",
      "name": "Course Project Intelligence",
      "enabled": false,
      "transport": "stdio",
      "command": "python",
      "args": ["-m", "app.main", "stdio"],
      "cwd": "D:/WorkStation/Trae/course-project-intelligence-mcp-server",
      "env": {},
      "toolNamePrefix": "mcp.course_project"
    }
  ]
}
```

注意：

- 示例文件默认 `enabled: false`
- 实际使用时，复制为 `config/mcp.servers.json`
- 再改成 `enabled: true`
- 再把 `cwd` 改成你本地 Python MCP 项目的真实路径

### Course Project Intelligence MCP Server

目标外部插件：

- Course Project Intelligence MCP Server
- 用于检索 GitHub / Gitee / Web 上的高校计算机课程项目资料
- 特别关注南开大学计算机课程项目方向

典型启动方式：

```bash
python -m app.main stdio
```

或：

```bash
python3 -m app.main stdio
```

### 工具映射规则

MCP 原始工具名会映射为 Gateway 工具名：

```text
<toolNamePrefix>.<originalToolName>
```

例如：

```text
mcp.course_project.search_course_projects
```

说明：

- 工具名来自 MCP `listTools()` 动态发现
- 不在 Gateway 里硬编码具体工具名
- `inputSchema` 继承 MCP tool 的 `inputSchema`
- 调用链路仍然是：
  - `:tool`
  - `ToolCallExecutor`
  - `ToolRegistry`
  - `GatewayMcpClient`
  - MCP `callTool`

示例：

```text
:tool mcp.course_project.search_course_projects {"query":"南开大学 计算机 大作业","top_k":5}
```

## 稳定性与失败行为

当前设计目标：

- 单个 MCP Server 连接失败，不影响 Gateway 启动
- 单个 MCP tool 调用失败，返回 `ok: false`，不打崩 Gateway
- 审计写入失败，不影响主流程
- `ToolRegistry` 中的工具异常，会被包装成失败结果

## 当前验证状态

当前验证分层：

```bash
npm run typecheck
npm run build
npm run gateway:check
npm run gateway:check:live
npm run sandbox:wsl:check
```

- `npm run gateway:check`：不依赖真实模型/embedding API，适合作为日常开发门禁
- `npm run gateway:check:live`：增加真实模型与 embedding API 探测，适合作为联调/发布前验证

Gateway v0.5 还做过一轮真实 MCP 联通验证：

- 无 `config/mcp.servers.json` 时，Gateway 可正常启动
- 外部 stdio MCP Server 可被发现、注册、列出、手动调用

Sandbox v0.9 已额外验证：

- WSL worker `GET /health`
- `POST /run` 执行 `node -v`
- `D:\WorkStation\agent-rebuild -> /mnt/d/WorkStation/agent-rebuild`
- Docker `/workspace` 挂载
- `~/sandbox-worker/logs/sandbox-audit.jsonl` 写入

## 相关文档

- `ToDo/README_GATEWAY_V0.4.md`
- `ToDo/README_GATEWAY_V0.5.md`
- `docs/sandbox.md`
- `docs/sandbox-v0.1-final-report.md`

## License

MIT
