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

## 当前边界

当前明确不做：

- 自动工具调用循环
- 多 Agent
- WebSocket
- 前端 UI
- 插件市场
- Docker Sandbox
- 复杂权限 / RBAC
- 模型自动选择工具
- Agent planner

`packages/memory` 的架构、SQLite 表结构、索引流程、embedding 流程、hybrid search 设计在 Gateway v0.5 中没有改动。

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
npm run gateway:check

npm run reindex
npm run backfill:embeddings
npm run scheduler
```

说明：

- `npm run gateway`：启动 Gateway CLI
- `npm run gateway:check`：执行 `typecheck + build + smoke + system-detect`

## Gateway CLI

### 基础命令

```text
记住：<内容>
查记忆 <关键词>
读文件 <相对路径>
flush
recover
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
:tools
:tool <name> <json>
```

示例：

```text
:tool memory.search {"query":"Gateway v0.4","topK":5}
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
- `:tools`：列出全部已注册工具，包括内置工具和 MCP tools
- `:tool`：通过现有 Tool Call Protocol 手动调用工具

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

当前命令已通过：

```bash
npm run typecheck
npm run build
npm run gateway:check
```

Gateway v0.5 还做过一轮真实 MCP 联通验证：

- 无 `config/mcp.servers.json` 时，Gateway 可正常启动
- 外部 stdio MCP Server 可被发现、注册、列出、手动调用

## 相关文档

- `ToDo/README_GATEWAY_V0.4.md`
- `ToDo/README_GATEWAY_V0.5.md`

## License

MIT
