# Agent Gateway v0.5

## 1. 本版目标

v0.5 引入 MCP Adapter（当前仅 stdio）：

- 连接外部 MCP Server
- 发现 MCP tools
- 映射注册到 Gateway ToolRegistry
- 复用现有 Tool Call Protocol，通过 `:tool` 手动调用

明确不做：

- 自动工具调用
- 多 Agent
- WebSocket
- 前端 UI

---

## 2. MCP 配置

### 2.1 配置文件位置

- `config/mcp.servers.json`
- 若文件不存在，Gateway 正常启动，MCP 功能为空

### 2.2 示例文件

- `config/mcp.servers.example.json`
- 默认 `enabled=false`，避免首次启动失败

### 2.3 示例配置（Course Project Intelligence）

```json
{
  "servers": [
    {
      "id": "course_project",
      "name": "Course Project Intelligence",
      "enabled": true,
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

---

## 3. Python MCP Server 启动方式

Course Project Intelligence MCP Server 支持 stdio 启动：

```bash
python -m app.main stdio
```

或：

```bash
python3 -m app.main stdio
```

Gateway 会按配置中的 `command + args + cwd` 自动拉起。

---

## 4. Tool 映射规则

MCP 的原始工具名会映射为 Gateway 工具名：

```txt
<toolNamePrefix>.<originalToolName>
```

例如：

```txt
mcp.course_project.search_course_projects
```

说明：

- 工具名不硬编码，来自 MCP `listTools()` 动态发现
- `inputSchema` 继承 MCP tool 的 `inputSchema`
- 调用路径仍是 `:tool -> ToolCallExecutor -> ToolRegistry.invoke`

---

## 5. REPL 命令

- `:mcp` / `:mcp status`
  - 查看 MCP server 连接状态、错误信息、已注册工具数
- `:mcp tools`
  - 查看 MCP 发现并映射的工具列表
- `:tools`
  - 查看全部 Gateway 工具（包括 `memory.search` 与 `mcp.*`）
- `:tool <name> <json>`
  - 手动调用工具，输出 ToolCallRecord

示例：

```txt
:tool mcp.course_project.search_course_projects {"query":"南开大学 计算机 大作业","top_k":5}
```

---

## 6. 失败行为

- 配置缺失：Gateway 正常启动
- 单个 MCP server 连接失败：不影响其他 MCP server 和 Gateway 主流程
- MCP tool 调用失败：返回 `ok:false`，不会打崩 Gateway
