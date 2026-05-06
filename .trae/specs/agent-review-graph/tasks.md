# AgentReview-Graph Tasks

## Phase 1：核心类型与目录结构

### Task 1：新增 ReviewGraph 目录

创建目录：

```text
packages/gateway/reviewGraph/
packages/gateway/reviewGraph/agents/
```

新增文件：

```text
types.ts
toolPolicy.ts
subAgentRunner.ts
graphRunner.ts
reportBuilder.ts
index.ts
agents/explore.ts
agents/plan.ts
agents/implement.ts
agents/test.ts
agents/verify.ts
agents/security.ts
agents/reviewer.ts
agents/index.ts
```

验收：

- 所有新增多 Agent 代码位于 `packages/gateway/reviewGraph/`
- 不移动、不重命名现有核心模块

### Task 2：实现核心类型

在 `packages/gateway/reviewGraph/types.ts` 中定义：

- `GraphNode`
- `TaskType`
- `FinalStatus`
- `AgentStatus`
- `ToolCallRecord`
- `AgentResult`
- `AgentDefinition`
- `ToolPolicyCheck`
- `ReviewGraphState`
- `ReviewGraphRunResult`

要求：

- 不使用 any
- payload 使用 JsonValue
- 类型可被外部导出

验收：

- [x] TypeScript 编译通过
- [x] 类型字段满足 spec 要求

## Phase 2：ToolPolicy

### Task 3：实现 ToolPolicy

在 `packages/gateway/reviewGraph/toolPolicy.ts` 中实现：

```ts
checkToolPolicy(params): ToolPolicyCheck
```

检查顺序：

1. deniedTools 命中 → deny
2. allowedTools 不包含 → deny
3. canSpawnAgents=false 且调用 agent.spawn → deny
4. Implement Agent 修改非 targetFiles → deny
5. 敏感文件检查 → deny
6. 路径越界检查 → deny
7. 危险 shell 检查 → deny
8. 删除文件检查 → deny
9. 未授权网络访问 → deny

敏感路径包括：

```text
.env
.ssh
id_rsa
id_ed25519
token
credential
credentials
secret
private_key
```

危险命令包括：

```text
rm -rf
sudo
git push
git reset --hard
git clean
npm publish
curl upload
wget post
chmod 777
del
rmdir
Remove-Item
```

验收：

- [x] allowedTools 通过
- [x] deniedTools 拒绝
- [x] targetFiles 限制生效
- [x] 敏感文件拒绝
- [x] 危险 shell 拒绝
- [x] 路径越界拒绝
- [x] 删除文件拒绝

## Phase 3：Agent 定义

### Task 4：定义 7 类执行 Agent

在 `packages/gateway/reviewGraph/agents/` 下实现：

1. Explore Agent
2. Plan Agent
3. Implement Agent
4. Test Agent
5. Verify Agent
6. Security Agent
7. Reviewer Agent

说明：

- Coordinator 不单独作为 LLM 自由执行 Agent
- Coordinator 的调度职责由 ReviewGraphRunner 程序化承担
- 这样可以避免 LLM 自由 spawn 和流程失控

每个 AgentDefinition 必须包含：

```ts
name
node
systemPrompt
allowedTools
deniedTools
canSpawnAgents
maxToolCalls
```

验收：

- [x] Explore 只读
- [x] Plan 只读
- [x] Implement 只能修改 targetFiles
- [x] Test 只能运行安全测试命令
- [x] Verify 独立存在
- [x] Security 不修改文件
- [x] Reviewer 不修改文件
- [x] canSpawnAgents 全部为 false

## Phase 4：SubAgentRunner

### Task 5：实现 SubAgentRunner

在 `packages/gateway/reviewGraph/subAgentRunner.ts` 中实现 SubAgentRunner。

职责：

1. 接收 AgentDefinition、userPrompt、context、ReviewGraphState
2. 生成 subRunId
3. 构建独立 systemPrompt
4. 使用现有 modelProvider / AgentRunner 能力执行子 Agent
5. 工具调用前执行 ToolPolicy
6. 工具调用写入 audit log
7. 不把子 Agent 工具中间结果塞回主上下文
8. 返回 AgentResult

建议接口：

```ts
run(input: {
  agentDef: AgentDefinition;
  userPrompt: string;
  context: string;
  state: ReviewGraphState;
}): Promise<AgentResult>
```

验收：

- [x] 每次生成唯一 subRunId
- [x] 工具拒绝时返回 error 或记录 policyDecision=deny
- [x] 子 Agent 返回结构化 AgentResult
- [x] canSpawnAgents=false 时 agent.spawn 被拒绝

## Phase 5：ReviewGraphRunner

### Task 6：实现 ReviewGraphRunner

在 `packages/gateway/reviewGraph/graphRunner.ts` 中实现 ReviewGraphRunner。

正常执行顺序：

```text
explore → plan → implement → test → verify → security → reviewer
```

节点输入关系：

- Explore 输出给 Plan
- Plan 的 targetFiles 约束 Implement
- Implement 输出 changedFiles 给 Test
- Test 输出给 Verify
- Verify 输出给 Security
- Security 输出给 Reviewer

失败回退：

```text
Test fail → repairRounds++ → plan
Verify fail → repairRounds++ → plan
Security deny → blocked
Security needs_approval → needs_approval
repairRounds >= maxRepairRounds → failed
```

默认：

```text
maxRepairRounds = 3
```

验收：

- [x] 正常流程可以完成
- [x] Test fail 能回退
- [x] Verify fail 能回退
- [x] Security deny 能阻断
- [x] needs_approval 能暂停
- [x] 超过修复轮数能 failed

## Phase 6：ReportBuilder

### Task 7：实现 AgentReview Report

在 `packages/gateway/reviewGraph/reportBuilder.ts` 中实现：

```ts
buildReport(state: ReviewGraphState): string
```

报告包含：

1. 用户目标
2. 任务类型
3. Agent 执行链
4. 修改文件
5. 测试结果
6. Verify 需求验收
7. Security 审计
8. Reviewer 最终结论
9. 后续建议
10. 审计引用

验收：

- [x] 正常完成能生成完整报告
- [x] blocked / failed / needs_approval 也能生成报告
- [x] 报告不包含子 Agent 全量中间上下文

## Phase 7：审计日志扩展

### Task 8：扩展 ToolCallExecutor 审计字段

修改现有 `packages/gateway/toolCallExecutor.ts` 的审计记录结构。

新增可选字段：

```ts
runId?: string;
parentRunId?: string;
subRunId?: string;
agentName?: string;
node?: string;
policyDecision?: "allow" | "deny" | "needs_approval";
```

要求：

- 字段全部可选
- 不影响现有 audit log 消费方
- ReviewGraph 工具调用必须传入这些字段

验收：

- [x] 现有测试不受影响
- [x] 新字段能正确写入
- [x] 被拒绝工具调用也写入审计

## Phase 8：Gateway 集成

### Task 9：新增 autoReviewGraphEnabled

在 Gateway 配置中新增：

```ts
autoReviewGraphEnabled?: boolean
```

默认：

```text
false
```

### Task 10：接入 ReviewGraphRunner

在 Gateway handle 流程中增加判断：

```text
如果 autoReviewGraphEnabled=true
并且输入是开发任务
则调用 ReviewGraphRunner.run()
否则保持原 AgentRunner 流程
```

要求：

- 不影响 Session Memory
- 不影响 MemoryAutoWriter
- 不影响普通聊天
- ReviewGraph 结果作为 Gateway 响应返回

验收：

- [x] 配置关闭时行为不变
- [x] 配置开启时开发任务走 ReviewGraph
- [x] 普通非开发任务不走 ReviewGraph

## Phase 9：测试

### Task 11：ToolPolicy 测试

覆盖：

- allowedTools 允许
- deniedTools 拒绝
- 非 allowedTools 拒绝
- Implement 修改非 targetFiles 拒绝
- .env 拒绝
- .ssh / id_rsa 拒绝
- git push 拒绝
- rm -rf 拒绝
- 删除文件拒绝
- 路径越界拒绝

### Task 12：SubAgentRunner 测试

覆盖：

- 正常执行返回 AgentResult
- subRunId 唯一
- 工具调用经过 ToolPolicy
- policy deny 被记录
- canSpawnAgents=false 时拒绝 agent.spawn

### Task 13：ReviewGraphRunner 测试

覆盖：

- 正常全流程
- Test fail 回退到 Plan
- Verify fail 回退到 Plan
- Security deny → blocked
- Security needs_approval → needs_approval
- repairRounds 超限 → failed
- 最终报告生成

### Task 14：Gateway 集成测试

覆盖：

- autoReviewGraphEnabled=false 时不触发
- autoReviewGraphEnabled=true 且开发任务时触发
- 普通任务不触发
- Gateway 响应包含 AgentReview Report 摘要
- 现有 Session Memory 流程不受影响

## 任务依赖

```text
Task 1 → Task 2
Task 2 → Task 3 / Task 4
Task 3 + Task 4 → Task 5
Task 5 → Task 6
Task 6 → Task 7
Task 5 + Task 6 → Task 8
Task 6 + Task 7 → Task 9 / Task 10
Task 3-10 → Task 11-14
```

## 最终验收

- [x] 可以启用 autoReviewGraphEnabled
- [x] 开发任务进入 ReviewGraph
- [x] 完整流程可执行：Explore → Plan → Implement → Test → Verify → Security → Reviewer
- [x] Test/Verify 失败可回退
- [x] Security 可阻断高风险行为
- [x] Verify 能独立识别需求遗漏和假通过风险
- [x] Audit Log 可追踪每个子 Agent 的工具调用
- [x] AgentReview Report 字段完整
- [x] 配置关闭时原系统行为不变
- [x] 所有新增测试通过
- [x] 现有测试通过
