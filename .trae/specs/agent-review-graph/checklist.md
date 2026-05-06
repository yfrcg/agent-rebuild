# AgentReview-Graph Checklist

## 架构合规

- [ ] 新增多 Agent 相关模块全部放在 `packages/gateway/reviewGraph/` 目录下
- [ ] 不推翻现有 Gateway、AgentRunner、ToolRegistry、Skill、Memory、AuditLog、DevTaskLoop、Sandbox/Policy
- [ ] 不直接引入 LangGraph、CrewAI、AutoGen 等重型多 Agent 框架
- [ ] ReviewGraph 采用轻量 TypeScript 状态机实现
- [ ] 多 Agent 采用 fork-return 模式，不做自由群聊式 Swarm
- [ ] Coordinator 不直接改代码，不直接运行 shell，不自由递归创建子 Agent
- [ ] 子 Agent 默认不能再创建子 Agent，避免递归爆炸
- [ ] 不新增无关临时文件

## 总体架构图

```text
User Request
   ↓
Gateway / Main Agent
   ↓
Intent Router
   ↓
ReviewGraphRunner
   ↓
Explore → Plan → Implement → Test → Verify → Security → Reviewer
   ↑                         ↓
   └────── Repair Plan ← Test/Verify Fail
   ↓
AgentReview Report / Audit Log
```

## 类型系统

- [ ] `ReviewGraphState` 包含 runId、userGoal、taskType、currentNode、targetFiles、constraints、各节点结果、repairRounds、maxRepairRounds、auditRefs、finalStatus
- [ ] `AgentResult` 包含 subRunId、agentName、node、status、summary、payload、durationMs、toolCalls、auditRefs
- [ ] `AgentDefinition` 包含 name、node、systemPrompt、allowedTools、deniedTools、canSpawnAgents、maxToolCalls
- [ ] `ToolPolicyCheck` 包含 allowed、reason、violations
- [ ] 类型定义不使用 `any`
- [ ] TypeScript 编译通过

## 8 类 Agent

- [ ] Explore Agent：只读探索代码，输出相关文件、证据、风险点
- [ ] Plan Agent：只读规划，输出 targetFiles、steps、risks、requiresApproval
- [ ] Implement Agent：只按 Plan 修改 targetFiles，返回 changedFiles 和 diff 摘要
- [ ] Test Agent：只运行测试、typecheck、lint、verify 命令，返回结构化测试结果
- [ ] Verify Agent：独立验证需求覆盖、假通过风险、边界条件、遗漏项
- [ ] Security Agent：审计敏感文件、路径越界、危险命令、网络外发、链式风险
- [ ] Reviewer Agent：综合 Test、Verify、Security，输出最终交付判断
- [ ] Coordinator 逻辑由 ReviewGraphRunner 控制，不让 LLM 自由调度执行流

## SubAgentRunner

- [ ] 每次子 Agent 运行生成唯一 subRunId
- [ ] 每个子 Agent 有独立 systemPrompt
- [ ] 每个子 Agent 有独立 allowedTools / deniedTools
- [ ] 子 Agent 工具调用前必须经过 ToolPolicy 检查
- [ ] 子 Agent 的中间工具结果不污染主上下文
- [ ] 子 Agent 只返回结构化 AgentResult
- [ ] canSpawnAgents 默认 false
- [ ] 完整工具调用写入 audit log

## ToolPolicy

- [ ] deniedTools 命中时拒绝
- [ ] allowedTools 不包含时拒绝
- [ ] Implement Agent 的 targetFiles 限制生效
- [ ] 敏感文件被拒绝：.env、.ssh、id_rsa、token、credential、secret、private_key
- [ ] 危险 shell 命令被拒绝：rm、sudo、git push、git reset --hard、npm publish、curl 上传等
- [ ] 删除文件操作默认拒绝
- [ ] 路径越界默认拒绝
- [ ] 未授权网络访问默认拒绝
- [ ] policyDecision 写入审计日志

## ReviewGraphRunner

- [ ] 正常流程：explore → plan → implement → test → verify → security → reviewer
- [ ] Test 失败时回退到 plan，repairRounds++
- [ ] Verify 失败时回退到 plan，repairRounds++
- [ ] Security deny 时 finalStatus=blocked 并终止
- [ ] Security needs_approval 时 finalStatus=needs_approval 并暂停
- [ ] repairRounds >= maxRepairRounds 时 finalStatus=failed
- [ ] 正常完成时 finalStatus=passed
- [ ] 最终生成 AgentReview Report

## 审计日志

- [ ] 子 Agent 工具调用日志包含 runId、subRunId、agentName、node、toolName、policyDecision
- [ ] 日志包含 status、durationMs、argsPreview、stdoutPreview、stderrPreview、changedFiles
- [ ] 新增审计字段保持可选，向后兼容现有日志
- [ ] 可以查询某次 run 的全部工具调用
- [ ] 可以查询被拒绝的工具调用和高风险行为

## Gateway 集成

- [ ] 新增 autoReviewGraphEnabled 配置项，默认 false
- [ ] 只有开发任务且配置启用时触发 ReviewGraph
- [ ] ReviewGraph 结果注入 Gateway 响应
- [ ] 现有 Session Memory、MemoryAutoWriter、普通 AgentRunner 流程不受影响
- [ ] 关闭 autoReviewGraphEnabled 时行为与原系统一致

## 测试

- [ ] ToolPolicy 单元测试覆盖 allowedTools、deniedTools、targetFiles、敏感文件、危险 shell、路径越界
- [ ] SubAgentRunner 单元测试覆盖 subRunId、权限拒绝、结构化结果
- [ ] ReviewGraphRunner 测试覆盖正常流程、Test 回退、Verify 回退、Security deny、needs_approval、repairRounds 超限
- [ ] ReportBuilder 测试覆盖报告字段完整性
- [ ] 所有网络调用 mock
- [ ] 现有测试全部通过
- [ ] TypeScript 编译无错误
