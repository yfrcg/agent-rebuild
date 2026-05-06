# AgentReview-Graph Spec

## 1. 背景

当前 Gateway 主要是单层 Agent 扁平架构：用户请求进入 Gateway 后，由 AgentRunner 单循环完成推理、工具调用和响应。该模式适合普通问答和简单开发任务，但在复杂代码任务中存在几个问题：

1. 缺少明确任务拆解
2. 工具调用上下文容易污染主对话
3. 实现、测试、验证、安全审计职责混在一起
4. 测试通过不代表需求真正完成
5. 缺少失败回退和可审计执行链
6. 高风险工具调用缺少 per-agent 权限边界

因此需要在不破坏现有架构的前提下，新增轻量多 Agent 执行层：AgentReview-Graph。

## 2. 目标

AgentReview-Graph 是一个 Gateway-Controlled Multi-Agent Code Review System。

它借鉴三类思想：

1. Claude Code 的 fork-return SubAgent：子 Agent 独立上下文执行，只返回最终摘要
2. LangGraph 的状态图思想：用显式节点和状态转换控制执行流
3. OpenClaw 的 Gateway/session/memory/workspace 隔离思想：所有 Agent 行为受统一 Gateway 控制，并写入审计日志

本项目不直接引入 LangGraph、CrewAI、AutoGen 等重型框架，而是用 TypeScript 实现轻量 ReviewGraph。

## 3. 总体架构

```text
User Request
   ↓
Gateway / Main Agent
   ↓
Intent Router
   ↓
ReviewGraphRunner
   ↓
Explore Agent
   ↓
Plan Agent
   ↓
Implement Agent
   ↓
Test Agent
   ↓
Verify Agent
   ↓
Security Agent
   ↓
Reviewer Agent
   ↓
AgentReview Report / Audit Log
```

失败回退：

```text
Test fail
   ↓
Plan → Implement → Test

Verify fail
   ↓
Plan → Implement → Test → Verify

Security deny
   ↓
blocked

Security needs_approval
   ↓
needs_approval
```

## 4. 设计原则

1. Main Agent 只负责入口和最终输出
2. ReviewGraphRunner 负责程序化调度，不让 LLM 自由控制全流程
3. 每个子 Agent 有独立 systemPrompt、allowedTools、deniedTools、subRunId
4. 子 Agent 默认不能创建子 Agent
5. 子 Agent 中间过程不回灌主上下文，只返回结构化 AgentResult
6. 所有工具调用必须经过 ToolPolicy
7. 所有工具调用必须写 audit log
8. 危险操作默认拒绝或需要人工确认
9. 新功能默认关闭，通过 autoReviewGraphEnabled 启用
10. 保持现有 Gateway、AgentRunner、ToolRegistry、Memory、Skill、AuditLog 向后兼容

## 5. 新增模块

新增目录：

```text
packages/gateway/reviewGraph/
  types.ts
  toolPolicy.ts
  subAgentRunner.ts
  graphRunner.ts
  reportBuilder.ts
  agents/
    explore.ts
    plan.ts
    implement.ts
    test.ts
    verify.ts
    security.ts
    reviewer.ts
    index.ts
  index.ts
```

说明：

- `types.ts`：ReviewGraph 核心类型
- `toolPolicy.ts`：per-agent 工具权限检查
- `subAgentRunner.ts`：fork-return 子 Agent 执行器
- `graphRunner.ts`：ReviewGraph 状态机
- `reportBuilder.ts`：最终报告生成
- `agents/`：各类 Agent 配置和 systemPrompt

## 6. Agent 定义

### 6.1 Explore Agent

职责：

- 只读探索代码结构
- 定位相关文件、测试、配置、工具注册点
- 输出 evidence，不做修改

允许工具：

```text
read_file, list_files, grep_search, git.status
```

禁止：

```text
write_file, edit_file, file.patch, run_shell, agent.spawn
```

输出：

```json
{
  "files": [],
  "evidence": [],
  "risks": [],
  "summary": ""
}
```

### 6.2 Plan Agent

职责：

- 根据 Explore 结果制定最小修改计划
- 明确 targetFiles、steps、risks、requiresApproval
- 不做代码修改

输出：

```json
{
  "targetFiles": [],
  "steps": [],
  "risks": [],
  "requiresApproval": false
}
```

### 6.3 Implement Agent

职责：

- 只修改 Plan.targetFiles
- 不主动扩大范围
- 不删除文件
- 不改密钥和环境文件
- 返回 changedFiles 和 diff 摘要

允许工具：

```text
read_file, edit_file, file.patch
```

禁止：

```text
file.delete, run_shell, web.fetch, git.push, agent.spawn
```

输出：

```json
{
  "changedFiles": [],
  "diffSummary": [],
  "notes": []
}
```

### 6.4 Test Agent

职责：

- 运行测试、类型检查、lint、verify 命令
- 结构化记录 exitCode、stdout、stderr、timedOut
- 判断失败原因
- 不修改代码

允许工具：

```text
run_shell_readonly, typecheck.run, lint.run, verify.run, git.status
```

输出：

```json
{
  "passed": true,
  "commands": [],
  "failures": [],
  "stdoutPreview": "",
  "stderrPreview": ""
}
```

### 6.5 Verify Agent

Verify Agent 必须独立存在，不合并到 Test 或 Reviewer。

职责：

- 对照用户原始需求检查是否真正完成
- 对照 Plan 检查步骤是否覆盖
- 对照 diff 检查是否有无关修改
- 检查测试是否假通过
- 检查边界条件、异常路径、兼容性

输出：

```json
{
  "status": "pass | fail | uncertain",
  "score": 0,
  "requirementCoverage": [],
  "missingCases": [],
  "falsePassRisks": [],
  "recommendation": "pass | needs_minor_fix | needs_rework"
}
```

### 6.6 Security Agent

职责：

- 审计工具调用链
- 检查敏感文件、路径越界、危险命令、网络外发
- 检查 read secret → compress → upload 等链式风险
- 输出安全决策

输出：

```json
{
  "decision": "allow | deny | needs_approval",
  "risks": [],
  "evidence": []
}
```

### 6.7 Reviewer Agent

职责：

- 综合 Test、Verify、Security
- 判断是否可交付
- 给出 blockingIssues、warnings、suggestions、finalDecision

输出：

```json
{
  "approved": false,
  "blockingIssues": [],
  "warnings": [],
  "suggestions": [],
  "finalDecision": "mergeable | needs_fix | blocked"
}
```

## 7. ReviewGraphState

系统需要维护 ReviewGraphState：

```ts
interface ReviewGraphState {
  runId: string;
  userGoal: string;
  taskType: TaskType;
  currentNode: GraphNode;
  targetFiles: string[];
  constraints: string[];

  explore?: AgentResult;
  plan?: AgentResult;
  implement?: AgentResult;
  test?: AgentResult;
  verify?: AgentResult;
  security?: AgentResult;
  reviewer?: AgentResult;

  repairRounds: number;
  maxRepairRounds: number;
  auditRefs: string[];
  finalStatus: FinalStatus;
}
```

状态转换规则：

1. 初始节点为 explore
2. 正常顺序为 explore → plan → implement → test → verify → security → reviewer
3. Test 失败回退到 plan
4. Verify 失败回退到 plan
5. Security deny 直接 blocked
6. Security needs_approval 暂停
7. repairRounds 超限后 failed
8. Reviewer 完成后 passed 或 failed

## 8. ToolPolicy

每次子 Agent 工具调用前必须执行 ToolPolicy。

检查顺序：

1. deniedTools 命中 → deny
2. allowedTools 不包含 → deny
3. canSpawnAgents=false 且调用 agent.spawn → deny
4. Implement 修改非 targetFiles → deny
5. 访问敏感文件 → deny
6. 路径越界 → deny
7. 危险 shell → deny
8. 删除文件 → deny
9. 未授权网络访问 → deny

ToolPolicy 返回：

```ts
interface ToolPolicyCheck {
  allowed: boolean;
  reason: string;
  violations: string[];
}
```

## 9. SubAgentRunner

SubAgentRunner 使用 fork-return 模式。

要求：

1. 每次运行生成 subRunId
2. 构建独立 systemPrompt
3. 注入 agentDef、allowedTools、constraints、state 摘要
4. 工具调用前执行 ToolPolicy
5. 工具结果只进入子 Agent 上下文
6. 主上下文只接收 AgentResult
7. 完整工具日志写 audit log
8. 子 Agent 默认不能 spawn 新 Agent

返回：

```ts
interface AgentResult {
  subRunId: string;
  agentName: string;
  node: GraphNode;
  status: AgentStatus;
  summary: string;
  payload: JsonValue;
  durationMs: number;
  toolCalls: ToolCallRecord[];
  auditRefs: string[];
}
```

## 10. 审计日志扩展

ToolCallExecutor.writeAudit() 新增可选字段：

```ts
runId?: string;
parentRunId?: string;
subRunId?: string;
agentName?: string;
node?: string;
policyDecision?: "allow" | "deny" | "needs_approval";
```

要求：

1. 新字段可选，保持向后兼容
2. ReviewGraph 工具调用必须写入这些字段
3. 支持查询某次 run、某个 Agent、被拒绝调用、高风险行为、修改文件

## 11. Gateway 集成

Gateway 新增配置：

```ts
autoReviewGraphEnabled?: boolean;
```

默认值：

```text
false
```

触发条件：

1. autoReviewGraphEnabled=true
2. 输入被判定为开发任务
3. 当前任务适合多 Agent 流程

行为：

- 满足条件时调用 ReviewGraphRunner.run()
- 将 AgentReview Report 注入 Gateway 响应
- 不满足条件时保持原 AgentRunner 单循环
- 不影响 Session Memory 和 MemoryAutoWriter

## 12. AgentReview Report

ReviewGraph 完成后生成报告：

```markdown
# AgentReview Report

## 1. 用户目标

## 2. 任务类型

## 3. Agent 执行链

## 4. 修改文件

## 5. 测试结果

## 6. Verify 需求验收

## 7. Security 审计

## 8. Reviewer 最终结论

## 9. 后续建议
```

## 13. 非目标

本阶段不做：

1. 不做自由 Swarm 群聊
2. 不做多 Agent 互相 handoff
3. 不做嵌套子 Agent
4. 不引入 LangGraph/CrewAI/AutoGen
5. 不重写 Gateway
6. 不重写现有 ToolRegistry
7. 不默认开启多 Agent
8. 不默认允许高风险 shell 或网络外发

## 14. 验收标准

1. 可以通过配置启用 ReviewGraph
2. 开发任务能走完整多 Agent 流程
3. Explore 能输出相关文件和证据
4. Plan 能输出 targetFiles 和 steps
5. Implement 只能修改 targetFiles
6. Test 能输出结构化测试结果
7. Verify 能识别需求遗漏和假通过风险
8. Security 能阻断高风险行为
9. Reviewer 能给出最终交付判断
10. Audit Log 能追踪所有子 Agent 工具调用
11. 关闭 autoReviewGraphEnabled 后原系统行为不变
