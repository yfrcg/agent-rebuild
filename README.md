# agent-rebuild

AI Agent Gateway - Windows 本地版。Gateway 是控制层，所有工具调用必须经过 Gateway，不能绕过。

> 仅支持 Windows + Node.js >= 18。无需 Docker、WSL 或其他运行时依赖。

## 架构

```
用户输入 --> REPL 命令解析
              |
              +---> 内建命令（会话管理、记忆、MCP、工具手动调用）
              +---> Gateway.handle()
                      |
                      +---> ReviewGraphRunner（多 Agent 协作，autoReviewGraphEnabled 时触发）
                      |       +---> Explore Agent（只读代码探索）
                      |       +---> Plan Agent（生成实施计划）
                      |       +---> Implement Agent（执行代码修改，targetFiles 限制）
                      |       +---> Test Agent（运行 typecheck/lint/build/test）
                      |       +---> Verify Agent（独立需求验证，0-10 评分）
                      |       +---> Security Agent（安全审计 + 策略检查）
                      |       +---> Reviewer Agent（最终交付决策）
                      |       +---> ToolPolicy（8 层工具策略检查）
                      |
                      +---> AgentRunner（LLM 循环 + 工具调用 + DevTask）
                      |       +---> ContextBuilder（系统提示 + 记忆 + 技能 + 会话记忆）
                      |       +---> ContextCompressor（4-tier 上下文压缩）
                      |       +---> ModelProvider（DeepSeek / Mock）
                      |       +---> ToolCallExecutor -> ToolRegistry（29 个内建工具 + MCP 动态工具）
                      |             +---> file.*     文件读写/编辑/glob/grep/patch
                      |             +---> shell.*    PowerShell 执行（危险命令拦截）
                      |             +---> git.*      status/diff/commit
                      |             +---> dev.*      typecheck/lint/verify
                      |             +---> web.*      fetch/search（Tavily）
                      |             +---> todo.*     write/update/list
                      |             +---> agent.*    verify/policy/audit
                      |             +---> memory.*   检索/写入
                      |             +---> skill      技能调用
                      |             +---> mcp.*      MCP 插件工具
                      |
                      +---> MemoryAutoWriter（自动记忆写入 + 压缩）
                      +---> SessionMemoryManager（工作记忆 + 滚动摘要）
```

Gateway 在 `packages/gateway/gateway.ts` 的 `handle()` 中驱动完整链路：构建上下文 → 调用 LLM → 解析工具调用 → 权限检查 → 执行 → 结果返回 LLM，直到模型给出最终回复或达到最大轮次。

系统内置 **多 Agent 协作系统（ReviewGraph）**、**4-tier 上下文压缩管线**、**流式响应处理**、**自动记忆写入**、**会话工作记忆**和 **DevTask 自动修复循环**。

## 环境准备

- Windows 10/11
- Node.js >= 18
- DeepSeek API Key（用于 LLM 推理）
- 阿里云 DashScope API Key（可选，用于向量检索）

## 快速开始

```bash
# 克隆项目
git clone https://github.com/yfrcg/agent-rebuild.git
cd agent-rebuild

# 安装依赖
npm install

# 配置（复制模板后填写你的 API Key）
copy .env.example .env
# 编辑 .env 文件，填写 DEEPSEEK_API_KEY

# 启动 Gateway
npm run gateway             # tsx apps/gateway/src/main.ts
```

启动后进入 REPL 交互模式，直接输入问题即可与 Agent 对话。Agent 会自动调用工具执行文件操作、命令运行、记忆检索等任务。

## 可用工具

系统内置 **29 个工具**，按 family 分组，另有 MCP 插件动态工具：

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件操作** | file.read / file.write / file.edit / file.list | 基础文件读写、编辑、列目录 |
| | file.glob | 模式匹配查找文件（支持 glob 语法） |
| | file.grep | 正则搜索文件内容（支持上下文行） |
| | file.multi_edit | 原子化多处编辑（全部成功或全部回滚） |
| | file.patch | 应用 unified diff 补丁（支持 dryRun） |
| **Shell 执行** | shell.run / bash.run | 通过 PowerShell 执行命令，cwd 约束在工作区内 |
| | npm_test / run_test / build | 测试和构建快捷工具 |
| **Git** | git.status | 获取 Git 仓库状态（staged/unstaged/branch） |
| | git.diff | 获取差异（支持 staged/unstaged/maxChars） |
| | git.commit | 提交变更（需 amend 时支持 amend 模式） |
| **开发验证** | typecheck.run | 运行 TypeScript 类型检查，返回结构化结果 |
| | lint.run | 运行代码检查（ESLint/Prettier 等） |
| | verify.run | 完整验证流水线（typecheck + lint + test + build） |
| **Web** | web.fetch | HTTP/HTTPS 页面抓取（HTML 解析为 Markdown） |
| | web.search | 互联网搜索（Tavily API，需配置 API Key） |
| **Todo** | todo.write / todo.update / todo.list | 任务管理（创建/更新状态/列出/筛选） |
| **Agent** | agent.verify | 独立验证修改质量（生成验证报告） |
| | policy.check | 命令/路径安全策略检查（severity 分级） |
| | audit.query | 查询审计日志（按工具名/时间过滤） |
| **记忆** | memory.search | 混合检索（FTS + 向量 + RRF 融合） |
| | memory.write | 写入记忆（daily / long-term） |
| **技能** | skill | 调用已注册的 Skill 技能 |
| **MCP** | mcp.* | MCP 插件工具（动态发现，运行时注册） |

## 项目结构

```
agent-rebuild/
├── apps/gateway/src/
│   ├── main.ts                    # Gateway 启动入口（REPL 主循环）
│   └── agent/agentRunner.ts       # re-export
├── packages/
│   ├── gateway/                   # 核心网关层（73 个源文件）
│   │   ├── gateway.ts             # Gateway 主类（handle 入口）
│   │   ├── agentRunner.ts         # LLM 交互 + 工具循环 + DevTask
│   │   ├── contextBuilder.ts      # 系统提示 + 记忆 + 技能 + 会话记忆构建
│   │   ├── contextCompressor.ts   # 4-tier 上下文压缩管线
│   │   ├── streamProcessor.ts     # 流式响应处理器
│   │   ├── memoryAutoWriter.ts    # 自动记忆写入（重要性评分 + 压缩）
│   │   ├── sessionMemoryManager.ts # 会话工作记忆 + 滚动摘要
│   │   ├── sessionManager.ts      # 会话管理（创建、切换、绑定项目）
│   │   ├── sessionStore.ts        # 会话持久化（JSON 快照）
│   │   ├── toolCallExecutor.ts    # 工具调用执行器（4 层安全校验）
│   │   ├── toolRegistry.ts        # 工具注册中心
│   │   ├── builtinTools.ts        # 内建工具注册（29 个工具）
│   │   ├── permissionPolicy.ts    # 权限策略（plan mode + 危险操作拦截）
│   │   ├── sandbox.ts             # 策略守卫（文件路径 + 命令安全）
│   │   ├── pathGuard.ts           # 路径守卫（阻止系统目录访问）
│   │   ├── toolSecurityProfile.ts # 工具安全分类（risk level）
│   │   ├── config.ts              # 运行时配置加载
│   │   ├── webSearchProvider.ts   # Tavily Web 搜索提供商
│   │   ├── reviewGraph/           # 多 Agent 协作系统
│   │   │   ├── types.ts           # 核心类型（ReviewGraphState/AgentResult 等）
│   │   │   ├── toolPolicy.ts      # 8 层工具策略检查
│   │   │   ├── subAgentRunner.ts  # 子 Agent 运行器（fork-return 模式）
│   │   │   ├── graphRunner.ts     # ReviewGraph 状态机（7 节点流水线）
│   │   │   ├── reportBuilder.ts   # AgentReview 报告构建
│   │   │   └── agents/            # 7 类 Agent 定义
│   │   │       ├── explore.ts     # Explore Agent（只读代码探索）
│   │   │       ├── plan.ts        # Plan Agent（生成实施计划）
│   │   │       ├── implement.ts   # Implement Agent（执行代码修改）
│   │   │       ├── test.ts        # Test Agent（运行测试命令）
│   │   │       ├── verify.ts      # Verify Agent（独立需求验证）
│   │   │       ├── security.ts    # Security Agent（安全审计）
│   │   │       └── reviewer.ts    # Reviewer Agent（最终交付决策）
│   │   ├── tools/                 # 工具实现（7 个文件，29 个工具）
│   │   │   ├── sandboxedFile.ts   # file.* 工具（8 个）
│   │   │   ├── sandboxedBash.ts   # shell/build 工具（5 个）
│   │   │   ├── gitTools.ts        # git.* 工具（3 个）
│   │   │   ├── devTools.ts        # typecheck/lint/verify 工具（3 个）
│   │   │   ├── webFetch.ts        # web.fetch 工具
│   │   │   ├── todoTools.ts       # todo.* 工具（3 个）
│   │   │   └── agentTools.ts      # agent.* 工具（3 个）
│   │   ├── mcpManager.ts          # MCP 服务器管理（懒连接 + 重连）
│   │   ├── mcpConfig.ts           # MCP 多源配置加载
│   │   ├── mcpClient.ts           # MCP stdio 客户端
│   │   ├── mcpToolAdapter.ts      # MCP 工具映射适配
│   │   ├── commandParser.ts       # REPL 命令解析（:cmd / /skill）
│   │   ├── replCommandHandlers.ts # REPL 内建命令处理
│   │   ├── autoToolLoop.ts        # DevTask 自动修复循环
│   │   ├── modelProviderFactory.ts # 模型提供商工厂
│   │   ├── localCommandRunner.ts  # 本地命令执行器（PowerShell）
│   │   └── ...
│   ├── core/src/
│   │   ├── skills.ts              # Skill 系统（发现、解析、模板变量）
│   │   ├── config.ts              # 项目根目录解析
│   │   └── types.ts               # 通用类型定义
│   ├── model/
│   │   ├── deepseekProvider.ts    # DeepSeek 模型提供商（支持流式）
│   │   ├── mockProvider.ts        # Mock 模型（测试用）
│   │   └── types.ts               # ModelProvider 接口
│   ├── memory/src/
│   │   ├── hybridSearch.ts        # 混合检索（FTS + 向量 + RRF 融合）
│   │   ├── memoryWriter.ts        # 记忆写入（daily / long-term）
│   │   ├── memoryIndex.ts         # 记忆索引管理
│   │   ├── vectorSearch.ts        # 向量检索
│   │   └── ...
│   ├── session/src/
│   │   ├── transcript.ts          # 会话记录（append-only JSONL）
│   │   ├── compaction.ts          # 会话压缩
│   │   └── summary.ts             # 会话摘要
│   ├── storage/src/
│   │   └── db.ts                  # SQLite 数据库（FTS5 + 向量表）
│   └── audit/
│       └── auditLogger.ts         # 审计日志
├── tests/                         # 314 个测试，42 suites，0 失败
├── workspace/                     # 工作区（记忆、技能、配置）
│   ├── memory/                    # 日常记忆文件
│   ├── skills/                    # 项目级 Skill
│   ├── MEMORY.md                  # 长期记忆
│   └── AGENTS.md                  # Agent 行为规则
├── config/                        # 配置模板
├── docs/                          # 版本文档
├── logs/                          # 运行时日志
└── scripts/                       # 辅助脚本
```

## 配置参数

`.env` 文件（从 `.env.example` 复制）：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| GATEWAY_MODEL | 模型类型（deepseek / mock） | deepseek |
| DEEPSEEK_API_KEY | DeepSeek API Key | （必填） |
| DEEPSEEK_BASE_URL | DeepSeek API 地址 | https://api.deepseek.com/v1 |
| DEEPSEEK_MODEL | DeepSeek 模型名称 | deepseek-chat |
| DEEPSEEK_MAX_TOKENS | 最大生成 token 数 | 1024 |
| DEEPSEEK_TEMPERATURE | 生成温度 | 0.7 |
| DEEPSEEK_TIMEOUT_MS | API 超时时间（ms） | 30000 |
| WINDOWS_PROJECT_ROOT | 项目根目录 | （自动检测） |
| WORKSPACE_ROOT | 工作区路径 | （项目根目录/workspace） |
| GATEWAY_SANDBOX_ALLOWED_ROOTS | 沙箱白名单目录（分号分隔） | 项目根 + 工作区 |
| GATEWAY_MEMORY_TOP_K | 记忆检索返回数量 | 5 |
| GATEWAY_AUDIT_LOG_PATH | 审计日志路径 | logs/audit/gateway-audit.jsonl |
| GATEWAY_DEBUG | 调试模式 | false |
| GATEWAY_AUTO_TOOL_LOOP_ENABLED | 启用自动工具循环 | true |
| GATEWAY_AUTO_TOOL_LOOP_MAX_STEPS | 自动工具循环最大步数 | 5 |
| GATEWAY_DEV_TASK_MAX_STEPS | DevTask 最大步数 | 15 |
| GATEWAY_DEV_TASK_MAX_FIX_ROUNDS | DevTask 最大修复轮次 | 3 |
| GATEWAY_SESSION_AUTO_COMPACT_ENABLED | 会话自动压缩 | true |
| GATEWAY_SESSION_AUTO_COMPACT_MAX_ENTRIES | 自动压缩阈值（条数） | 80 |
| GATEWAY_RATE_LIMIT_MAX_REQUESTS | 限流最大请求数 | 30 |
| GATEWAY_RATE_LIMIT_WINDOW_MS | 限流窗口（ms） | 60000 |
| GATEWAY_CONFIRM_TOKEN_TTL_MS | 审批令牌有效期（ms） | 300000 |
| DASHSCOPE_API_KEY | 阿里云 DashScope API Key（向量检索用） | 可选 |
| DASHSCOPE_EMBED_MODEL | 向量模型名称 | text-embedding-v4 |
| DASHSCOPE_EMBED_DIMENSIONS | 向量维度 | 1024 |
| TAVILY_API_KEY | Tavily Web 搜索 API Key（web.search 工具用） | 可选 |

修改 `.env` 后需要重启 Gateway 才能生效。

## 常用命令

```bash
# Gateway
npm run gateway             # 启动 Gateway（REPL 模式）
npm run typecheck           # TypeScript 类型检查
npm test                    # 运行全部测试（314 个测试，0 失败）
npm run build               # 构建项目

# 辅助脚本
npx tsx scripts/smoke-gateway.ts           # 冒烟测试
npx tsx scripts/smoke-gateway-all.ts       # 全量冒烟测试
npx tsx scripts/system-detect-offline.ts   # 离线环境检测
```

## 技术设计

### 安全体系（4 层校验）

工具调用经过 4 层安全校验，从外到内逐层收紧：

| 层级 | 机制 | 文件 | 说明 |
|------|------|------|------|
| 1 | 路径守卫 | pathGuard.ts | 阻止访问系统目录（Windows、Program Files、.ssh 等） |
| 2 | 沙箱策略 | sandbox.ts | 验证工具是否允许执行、文件路径是否在白名单内 |
| 3 | 权限策略 | permissionPolicy.ts | plan mode 拦截、敏感路径检测、工作区外路径检测 |
| 4 | 工具执行 | toolCallExecutor.ts | 会话边界检查（allowedReadRoots / allowedWriteRoots）、read-before-edit、mtime 防覆盖 |

会话级别的安全边界：
- `allowedReadRoots` / `allowedWriteRoots`：限制文件操作范围
- `permission`：`chat-only`（仅聊天）或 `project-write`（允许项目文件修改）
- MCP 和 Skill 目录自动加入白名单，支持完整的文件管理操作

### 多 Agent 协作系统（ReviewGraph）

当 `autoReviewGraphEnabled=true` 时，Gateway 会自动检测开发类任务（fix/bug/feature/add/implement/refactor 等关键词），并启动 ReviewGraph 多 Agent 协作流水线。

**7 个专用 Agent：**

| Agent | 节点 | 权限 | 职责 |
|-------|------|------|------|
| Explore | explore | 只读 | 代码探索，识别相关文件和代码结构 |
| Plan | plan | 只读 | 生成实施计划，确定 targetFiles 和修改步骤 |
| Implement | implement | 可写（targetFiles 限制） | 执行代码修改，只能修改 Plan 指定的文件 |
| Test | test | 安全命令 | 运行 typecheck/lint/build/test，验证修改正确性 |
| Verify | verify | 只读（独立验证） | 独立验证需求覆盖度，0-10 评分，识别假通过风险 |
| Security | security | 只读 + 审计查询 | 安全审计，检查敏感文件访问、危险命令、策略违规 |
| Reviewer | reviewer | 只读（最小权限） | 最终交付决策，综合所有节点结果给出 approved/rejected |

**执行流水线：**
```
explore → plan → implement → test → verify → security → reviewer
                      ↑           ↓          ↓
                      └── repair ──┘          ↓
                      ↑                       ↓
                      └── repair ─────────────┘
```

**失败恢复机制：**
- Test 失败 → 回退到 Plan（repairRounds++，最多 3 轮）
- Verify 失败 → 回退到 Plan（修复后重新验证）
- Security deny → 阻断（blocked），终止流程
- Security needs_approval → 暂停等待人工审批
- 超过 maxRepairRounds → 标记为 failed

**8 层 ToolPolicy 检查：**
1. deniedTools 命中 → deny
2. allowedTools 不包含 → deny
3. canSpawnAgents=false 且调用 agent.spawn → deny
4. Implement Agent 修改非 targetFiles → deny
5. 敏感文件（.env/.ssh/id_rsa 等）→ deny
6. 路径越界 → deny
7. 危险命令（rm -rf/sudo/git push 等）→ deny
8. 删除操作 → deny

每个子 Agent 运行在隔离上下文中（fork-return 模式），工具调用独立审计，结果通过 AgentResult 结构化返回。最终生成 AgentReviewReport，包含完整的 agentChain、changedFiles、testResult、verifyResult、securityResult 和 reviewerResult。

## 子系统

### MCP 插件

MCP（Model Context Protocol）支持多源配置，按优先级合并：

1. `~/.agent-rebuild/mcp.servers.json`（用户全局）
2. `config/mcp.servers.json`（项目级）
3. `.mcp.json`（项目根目录）

支持懒连接模式（`mcpLazy: true`），首次 `handle()` 调用时才连接 MCP 服务器，减少启动时间。单个 MCP 服务器连接失败不影响其他服务器和主流程。

### Skill 技能系统

Skill 是可复用的提示词模板，存储为 `SKILL.md` 文件：

- **项目级**：`workspace/skills/<name>/SKILL.md`
- **用户全局**：`~/.agent-rebuild/skills/`、`~/.claude/skills/`

SKILL.md 支持 frontmatter 元数据（`when-to-use`、`allowed-tools`、`context`、`user-invocable`）和模板变量（`$ARGUMENTS`、`${SKILL_DIR}`）。

用户可通过 `/skillname args` 语法直接调用技能，LLM 也可通过 `skill` 工具程序化调用。

### 记忆系统

**检索**：SQLite FTS5 全文检索 + 向量检索，通过 Reciprocal Rank Fusion (RRF) 融合排序，支持时间衰减加权。

**自动写入**：`MemoryAutoWriter` 在每次对话后自动评估重要性（启发式评分），高分内容写入长期记忆（`MEMORY.md`），普通内容写入日常记忆（`memory/YYYY-MM-DD.md`）。`MEMORY.md` 超过阈值时自动触发压缩去重。

### 会话工作记忆

`SessionMemoryManager` 为每个会话维护：

- `working-memory.json`：当前会话的文件修改、命令执行、决策记录
- `rolling-summary.md`：滚动摘要，每次对话后追加更新
- `open-issues.json` / `decisions.jsonl`：待解决问题和决策日志

上下文构建时自动注入会话记忆，确保 Agent 在长会话中保持连贯性。

### DevTask 自动修复模式

当用户请求涉及测试、构建、修复等开发任务时，自动进入 DevTask 模式：

- 自动检测测试命令并运行
- 失败时分析错误并尝试修复
- 指数退避重试（500ms → 8s），最多 3 轮修复
- 追踪文件修改、命令执行、测试结果
- 会话持久化 DevTask 状态，支持跨会话恢复

### 上下文管理（4-tier 压缩管线）

`ContextCompressor` 在每次 LLM 调用前自动运行，防止上下文窗口溢出：

| Tier | 名称 | 触发条件 | 行为 |
|------|------|---------|------|
| 1 | Budget Truncation | 上下文利用率 > 50% | 大工具结果截断到 30K/15K 字符 |
| 2 | Stale Snip | 上下文利用率 > 60% | 同一文件的重复读取替换为占位符 |
| 3 | Microcompact | 空闲 > 5 分钟 | 清理旧工具结果，仅保留最近 2 条 |
| 4 | Auto-compact | 上下文利用率 > 85% | LLM 总结历史，替换为摘要 |

大工具结果（>30KB）自动持久化到 `logs/tool-results/`，上下文仅保留预览。

### 流式响应处理

`StreamProcessor` 提供实时流式输出能力：

- **StreamChunk 事件**：text_delta / tool_start / tool_end / error / done
- **事件回调**：onTextDelta / onToolStart / onToolEnd / onError / onDone
- **全局截断**：超过 20K 字符的响应自动截断（保留头部 10K + 尾部 8K）
- **大结果持久化**：超过 30KB 的流式结果自动写入磁盘

`StreamingModelProvider` 接口扩展了 `ModelProvider`，新增 `generateStream()` 方法返回 `AsyncIterable<string>`。DeepSeek 和 Mock 模型均已实现此接口。

### 本地命令执行

`LocalCommandRunner` 通过 `child_process.spawn` + `powershell.exe` 执行命令：

- cwd 必须在工作区目录内（pathGuard 验证）
- 环境变量自动过滤 TOKEN / SECRET / API_KEY / PASSWORD / CREDENTIAL
- stdout 256KB、stderr 128KB 自动截断
- 超时自动 kill 子进程
- 可通过 `GATEWAY_DISABLE_LOCAL_EXECUTION=1` 完全禁用本地执行

### 审计日志

所有工具调用自动写入 `logs/audit/gateway-audit.jsonl`，每行一条 JSON 记录，包含时间戳、工具名、参数、结果、风险等级、耗时。

### 会话管理

- 会话持久化为 JSON 快照（`SessionStore`）
- 支持创建、切换、列出会话
- 项目绑定：`bindProjectDir` 将会话绑定到特定项目目录
- 自动压缩：超过阈值时自动压缩旧会话记录
- Plan Mode：会话级别的计划模式，阻止修改操作

## FAQ

| 问题 | 解决方案 |
|------|---------|
| Gateway 启动后立即退出 | 检查 Node.js 版本是否 >= 18，或 LLM API Key 是否配置正确 |
| 工具执行超时 | 调整 GATEWAY_TOOL_TIMEOUT 值，或检查网络连接 |
| shell.run 命令被拒绝 | 检查 cwd 是否在工作区目录内，或命令是否被危险命令拦截 |
| MCP 服务器连接失败 | 检查 MCP 配置文件路径和服务器命令是否正确，单个失败不影响主流程 |
| 记忆检索无结果 | 运行 `npx tsx scripts/reindex.ts` 重建索引 |
| 会话上下文丢失 | 检查 ENABLE_SESSION_PERSISTENCE 是否为 true |

## 更新日志

### 2026-05-05（MCP/Skill 优化 + 安全白名单 + 记忆自动写入）

**MCP 系统优化：**
- 多源配置加载（用户全局 / 项目级 / 项目根目录），按优先级合并
- 懒连接模式（`mcpLazy`），首次 handle() 时才连接 MCP 服务器
- `ensureServerConnected()` 按需连接单个服务器

**Skill 技能系统：**
- SkillDefinition 增强：`whenToUse`、`allowedTools`、`context`（inline/fork）、`userInvocable`、`source`、`skillDir`
- 模板变量支持：`$ARGUMENTS`、`${SKILL_DIR}`
- 用户级 Skill 源：`~/.agent-rebuild/skills/`、`~/.claude/skills/`
- `/name` 命令解析：`/commit fix types` → 调用 commit 技能
- `skill` LLM 工具：模型可程序化调用技能
- `buildSkillDescriptions()` 注入系统提示

**安全白名单：**
- MCP 和 Skill 目录自动加入 `sandboxAllowedRoots`
- `SessionStore` 支持 `defaultAllowedReadRoots` / `defaultAllowedWriteRoots` / `defaultPermission`
- 新会话默认 `project-write` 权限，白名单目录可完整操作

**记忆自动写入（MemoryAutoWriter）：**
- 启发式重要性评分（长期模式 +15、决策模式 +10、错误修复 +12 等）
- 候选内容提取（用户输入、模型回复、工具调用、diff 补丁）
- 高分写入 `MEMORY.md`，普通写入 `memory/YYYY-MM-DD.md`
- `MEMORY.md` 超过 8KB 自动压缩去重

**会话工作记忆（SessionMemoryManager）：**
- `working-memory.json`：追踪文件修改、命令执行、测试结果
- `rolling-summary.md`：滚动摘要，每次对话后追加
- `open-issues.json` / `decisions.jsonl`：待解决问题和决策日志
- 敏感内容自动脱敏

**DevTask 自动修复模式：**
- 自动检测开发任务（测试、构建、修复）
- 测试失败 → 分析错误 → 修复 → 重试，最多 3 轮
- 指数退避（500ms → 8s）
- DevTask 状态跨会话持久化

**其他：**
- 测试：314 个通过，0 失败，0 跳过，42 suites
- 类型检查：通过
- 代码审查：无 TODO/FIXME/HACK 残留

### 2026-05-05（多 Agent 协作系统 + 工具扩展）

**ReviewGraph 多 Agent 协作系统：**
- 7 个专用 Agent（Explore/Plan/Implement/Test/Verify/Security/Reviewer）
- 7 节点状态机流水线，支持 Test/Verify 失败回退修复（最多 3 轮）
- 8 层 ToolPolicy 工具策略检查（deniedTools/allowedTools/targetFiles/sensitive/pathEscape/dangerous/delete/gitPush）
- SubAgentRunner fork-return 模式，子 Agent 隔离上下文，独立审计
- ReportBuilder 生成完整 AgentReviewReport（agentChain/changedFiles/testResult/verifyResult/securityResult/reviewerResult）
- Gateway 自动路由：检测开发类任务关键词，自动启动 ReviewGraph
- 审计日志扩展：runId/subRunId/agentName/node/policyDecision

**工具扩展（29 个内建工具）：**
- 新增 15 个工具：file.glob/file.grep/file.multi_edit/file.patch、git.status/git.diff/git.commit、typecheck.run/lint.run/verify.run、web.fetch、todo.write/todo.update/todo.list、agent.verify/policy.check/audit.query
- web.search（Tavily API）：互联网搜索工具
- file.grep 正则无 g 标志设计（避免 lastIndex 状态问题）
- file.patch 基于 entries 模型的 unified diff 解析器
- policy.check 包含 file.read 敏感文件检测和 Invoke-Expression 危险命令拦截

**测试：**
- 314 个通过，0 失败，42 suites
- 新增 51 个 ReviewGraph 测试（toolPolicy 32 + runner 9 + gateway 10）
- 新增 46 个工具测试（newTools.test.ts）
- 新增 web.search 测试（18 个）

### 2026-05-04（上下文管理 + 流式优化）

- ContextCompressor（4-tier 上下文压缩管线）
- StreamProcessor（流式响应处理器）
- StreamingModelProvider 接口，DeepSeek 和 Mock 模型实现 generateStream()
- 大工具结果（>30KB）自动持久化到 logs/tool-results/
- 测试：75 个通过

### 2026-05-04（Windows 本地化）

- 移除 WSL / Docker / sandbox-client / sandbox-worker 全部依赖
- Gateway 改为 Windows 原生本地执行，通过 PowerShell 执行命令
- GatewaySandbox 改为纯策略守卫
- 新增 toolSecurityProfile.ts、pathGuard.ts、localCommandRunner.ts
- 测试：49 个通过

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
