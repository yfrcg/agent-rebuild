# agent-rebuild

AI Agent Gateway - Windows 本地版。Gateway 是控制层，所有工具调用必须经过 Gateway，不能绕过。

> 仅支持 Windows + Node.js >= 18。无需 Docker、WSL 或其他运行时依赖。

## 架构

```
用户输入 --> Gateway（Agent Loop + 权限策略 + 记忆 + 会话）
                |
                +---> file.*         本地文件读写（cwd 约束）
                +---> shell.*        PowerShell 本地执行（cwd 约束 + 危险命令拦截）
                +---> web.*          需要 LLM_BASE_URL + LLM_API_KEY
                +---> app.chat       需要 TAVILY_API_KEY（流式输出）
```

Gateway 在 `src/gateway.ts` 的 `runAgentLoop()` 中驱动 LLM 循环：发送消息到 LLM，解析 tool_calls，通过 PermissionPolicy 权限检查后执行工具，结果返回 LLM 继续推理，直到无 tool_calls 或达到最大轮次（10 轮）。

## 环境准备

- Windows 10/11
- Node.js >= 18
- 包管理器：npm、pnpm 或 yarn
- OpenAI API Key（用于 LLM 推理，可选）
- Tavily API Key（用于 app.chat 搜索功能，可选）

## 快速开始

```bash
# 克隆项目
git clone https://github.com/yfrcg/agent-rebuild.git
cd agent-rebuild

# 安装依赖
pnpm install

# 配置（复制模板后填写你的 API Key）
copy .env.example .env
# 编辑 .env 文件，填写 LLM_API_KEY

# 初始化工作区目录
node scripts\init-workspace.js

# 启动 Gateway
pnpm gateway              # 简写模式（推荐）
pnpm gateway:direct       # 等价于 tsx apps/gateway/src/main.ts
```

启动后 Gateway 监听 `http://localhost:18081`，输出 `Registered tools: N tools (M families)`。

Gateway 支持两种运行方式：
- **REPL 模式**：直接输入问题，LLM 会调用工具执行（默认）
- **HTTP API 模式**：发送请求到 `http://localhost:18081/v1/responses`

## 可用工具

Gateway 启动时会输出 `Registered tools: N tools (M families)`，工具按 family 分组。

| 类型 | 工具 | 说明 |
|------|------|------|
| file | file.read / file.write / file.edit / file.delete / file.mkdir / file.list | 读取、写入、编辑、删除文件，创建目录，列目录 |
| terminal | shell.exec / shell.run | 通过 PowerShell 在本地执行命令，cwd 必须在工作区内 |
| terminal | npm_test / npm_install / npm_build | npm 专用快捷工具 |
| web | web.fetch_html / web.fetch_json / web.search_page | 抓取网页、JSON、搜索页面（需 API Key） |
| app | app.chat | 流式搜索对话（需 Tavily API Key，流式输出逐步显示） |

## 关键文件

| 文件 | 作用 | 是否需要修改 |
|------|------|:------------:|
| src/gateway.ts | 主入口，runAgentLoop()、注册工具、处理用户输入、流式输出 | 可选 |
| src/agentRunner.ts | LLM 交互、工具循环、MCP 客户端管理 | 可选 |
| src/agentClient.ts | LiteLLM 代理客户端 | 可选 |
| src/config.ts | 配置管理，加载 .env、DEFAULT_WORKSPACE_PATH | 可选 |
| src/permissionPolicy.ts | 权限策略，阻止危险操作 | 可选 |
| src/sandbox.ts | 执行策略守卫，调用 toolSecurityProfile 评估工具安全性 | 可选 |
| src/toolRegistry.ts | 工具注册中心，管理所有已注册工具 | 否 |
| src/toolTypes.ts | 工具 schema 定义 | 否 |
| src/localCommandRunner.ts | 本地命令执行器，通过 PowerShell 执行 | 可选 |
| src/toolCallExecutor.ts | 工具调用执行器 | 可选 |
| src/main.ts | Gateway 启动入口 | 否 |
| src/mcp*.ts | MCP 插件适配器（浏览器自动化等） | 否 |
| scripts/init-workspace.js | 工作区初始化脚本 | 否 |
| tests/*.test.ts | 测试文件（49 个测试，0 跳过） | 否 |

## 配置参数

`.env` 文件（从 `.env.example` 复制）：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| LLM_BASE_URL | LiteLLM 代理地址 | http://127.0.0.1:4000 |
| LLM_API_KEY | LLM API Key | sk-test |
| LLM_MODEL | 使用的模型 | gpt-4.1-nano |
| TAVILY_API_KEY | Tavily 搜索 API Key | 可选 |
| GATEWAY_PORT | Gateway 服务器端口 | 18081 |
| GATEWAY_BIND | Gateway 绑定地址 | 127.0.0.1 |
| DEFAULT_WORKSPACE_PATH | 工作区路径 | D:\WorkStation\agent-rebuild\workspace |
| ENABLE_WORKSPACE_MEMORY | 启用工作区记忆 | true |
| ENABLE_SESSION_PERSISTENCE | 启用会话持久化 | true |
| ENABLE_LLM_PROXY_DETECTION | 启用 LLM 代理自动检测 | true |
| GATEWAY_TOOL_TIMEOUT | 工具执行超时时间 | 30000 |
| GATEWAY_AUTH_TOKEN | Gateway 认证 Token | 123456 |
| GATEWAY_DISABLE_LOCAL_EXECUTION | 禁用本地命令执行（1 禁用，0 启用） | 0 |
| GATEWAY_LOG_LEVEL | 日志等级 | info |
| GATEWAY_AUDIT_LOG | 审计日志路径 | logs/audit/gateway-audit.jsonl |
| GATEWAY_TRANSPORT_MODE | 传输模式 | auto |
| GATEWAY_TOOL_READ_MAX_BYTES | 工具读取最大字节数 | 524288 |
| GATEWAY_TOOL_READ_TAIL_MAX_BYTES | 尾部读取最大字节数 | 204800 |

修改 `.env` 后需要重启 Gateway 才能生效。

## 常用命令

```bash
# Gateway 服务器
pnpm gateway                # 启动 Gateway
pnpm gw:watch               # 热重载启动
pnpm gateway:dev            # 开发模式启动

# 测试
pnpm test                   # 运行全部测试（49 个测试，0 跳过）
pnpm test:e2e               # 端到端测试

# 静态检查
pnpm lint                   # ESLint
pnpm format                 # Prettier 格式化
pnpm typecheck              # TypeScript 类型检查

# 构建
pnpm build                  # 构建项目
pnpm package:win            # 打包 Windows 可执行文件

# 脚本
npx tsx scripts\smoke-gateway.ts
npx tsx scripts\smoke-gateway-stream.ts
```

## 技术设计

### 权限策略（三层保护）

| 层级 | 机制 | 说明 |
|------|------|------|
| Plan Mode 拦截 | permissionPolicy.ts | plan mode 下强制拒绝所有修改、执行、网络请求 |
| 工具分类检查 | toolSecurityProfile.ts | 将工具分为 file / terminal / network / exec，按策略决定是否允许 |
| cwd 约束 | pathGuard.ts | 文件操作和命令执行的 cwd 必须在工作区目录内，阻止 C:\、D:\ 等危险路径 |

### pathGuard 路径守卫

验证 cwd 是否在工作区目录内，拦截以下危险路径：

- 根目录：C:\、D:\、/、~
- 系统目录：Windows、Program Files、System32
- 用户敏感目录：AppData、.ssh、Documents and Settings

### 审计日志

所有工具调用自动写入 `logs/audit/gateway-audit.jsonl`，每行一条 JSON 记录，包含时间戳、工具名、参数、结果。

### 本地命令执行

`LocalCommandRunner` 通过 `child_process.spawn` + `powershell.exe` 执行命令：

- cwd 必须在工作区目录内（pathGuard 验证）
- 环境变量自动过滤 TOKEN / SECRET / API_KEY / PASSWORD / CREDENTIAL
- stdout 256KB、stderr 128KB 自动截断
- 超时自动 kill 子进程
- 可通过 `GATEWAY_DISABLE_LOCAL_EXECUTION=1` 完全禁用本地执行

## 高级用法

### MCP 插件（可选）

MCP 客户端管理在 `src/mcpClientManager.ts`，需要在 `~/.codex/config.json` 中配置 MCP 服务器地址。配置后 Gateway 启动时会自动连接并注册插件工具。

### 记忆系统

Gateway 启动时自动加载历史记忆，构建 LLM 系统提示，对话过程中提取关键信息自动保存。记忆文件存储在工作区的记忆目录中。

启用/禁用：设置 `.env` 中的 `ENABLE_WORKSPACE_MEMORY=true/false`。

### 会话持久化

启用后会话数据自动保存，下次启动可恢复上下文。禁用后会话数据仅在内存中。

启用/禁用：设置 `.env` 中的 `ENABLE_SESSION_PERSISTENCE=true/false`。

### 流式输出和中断

Gateway 支持两种输出模式：
- **非流式模式**：LLM 返回完整文本后一次性输出（默认）
- **流式模式**：LLM 返回 token 时实时输出（支持 Ctrl+C 中断）

流式模式下工具调用时会自动切换到非流式模式，工具执行完成后恢复流式输出。

输入 `help` 查看内置命令列表。

## FAQ

| 问题 | 解决方案 |
|------|---------|
| Gateway 启动后立即退出 | 检查端口 18081 是否被占用，或 LLM 代理地址是否正确 |
| 网络请求报错 | 检查 TAVILY_API_KEY 或 LLM_API_KEY 是否配置正确 |
| 工具执行超时 | 调整 GATEWAY_TOOL_TIMEOUT 值，或检查网络连接 |
| npm_test 执行失败 | 检查 npm 是否已安装，以及 cwd 是否在工作区内 |
| shell.exec 命令被拒绝 | 检查 cwd 是否在工作区目录内，或命令是否被危险命令拦截 |
| Sandbox unavailable 错误 | 检查 GATEWAY_SANDBOX_MODE 是否设置为 off（默认值） |

## 更新日志

### 2026-05-04

- 移除 WSL / Docker / sandbox-client / sandbox-worker 全部依赖
- Gateway 改为 Windows 原生本地执行，通过 PowerShell 执行命令
- GatewaySandbox 改为纯策略守卫，不依赖外部 sandbox 包
- 新增 toolSecurityProfile.ts（工具分类检查）和 pathGuard.ts（路径守卫）
- 新增 localCommandRunner.ts（本地命令执行器，PowerShell + spawn）
- 新增 GATEWAY_DISABLE_LOCAL_EXECUTION 环境变量（完全禁用本地执行）
- 默认 sandbox 模式改为 off（所有工具可直接执行）
- 删除 packages/sandbox/（18 个文件）和 packages/sandbox-client/（3 个文件）
- 删除 5 个 sandbox 脚本和 5 个 sandbox 测试
- 统一日志目录结构：logs/audit/、logs/tool-results/、logs/test-results/、logs/runtime/、logs/errors/
- 移除 docs/personal-agent-education-ppt.html（162KB 临时文件）
- 测试：49 个通过，0 失败，0 跳过
- 类型检查：通过

### 2026-05-03

- 记忆系统：Gateway 启动时自动加载历史记忆，构建系统提示
- app.chat 工具：基于 Tavily 的流式搜索对话
- npm_* 工具：识别用户输入中的 npm 命令

### 2026-05-02

- Agent Loop 工具调用流程分析和文档更新

### 2026-05-01

- 文件读取默认返回字节数调整为 512KB
- 分页读取策略：小文件（<=512KB）全量读取，大文件优先头部
- Gateway 路径守卫安全拦截规则更新

## License

MIT
