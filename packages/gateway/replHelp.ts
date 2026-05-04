/**
 * 打印 Gateway 命令行帮助信息。
 *
 * 该函数集中描述可用命令、工具调用方式以及主要运行配置，
 * 方便操作者启动后立刻知道系统能做什么、该怎么做。
 */
export function printGatewayHelp(): void {
  console.log(`
Available commands:
1. 记住：<内容>
2. 查记忆 <关键词>
3. 读文件 <相对路径>
4. flush
5. recover
6. compact
7. help
8. :session
9. :session current
10. :session list
11. :session new [name]
12. :session switch <sessionId>
13. :session rename <name>
14. :mcp
15. :mcp status
16. :mcp tools
17. :skills
18. :skills show <name>
19. :skills use <name>
20. :skills current
21. :skills clear
22. use skill <name>
23. :tools
24. :tool <name> <json>
25. :sh <command>
26. :approvals
28. :approvals clear
29. :confirm <token>
30. :reject <token>
31. exit

Tool notes:
- :mcp / :mcp status shows MCP server connection status
- :mcp tools lists mapped MCP tools
- :skills lists discovered compatible SKILL.md files
- :skills show <name> prints one matched SKILL.md
- :skills use <name> activates one skill for the current session
- :skills current shows current session skill activation
- use skill <name> is a natural-language alias for :skills use <name>
- :tools lists registered tools
- :tool memory.search {"query":"Gateway v0.4","topK":5} manually calls a tool
- :tool bash.run {"command":"node -v"} runs one command locally through ToolCallExecutor
- :sh node -v runs a local command through ToolCallExecutor
- :approvals lists pending approval tokens for the current session
- :approvals clear rejects all pending approval tokens in the current session
- :confirm <token> executes one queued high-risk tool call after approval
- :reject <token> rejects one queued approval token

Normal chat path:
- User Input -> Gateway -> memory.search -> contextBuilder -> modelProvider -> auditLogger -> response

Runtime config:
- GATEWAY_MODEL=mock|deepseek
- GATEWAY_MEMORY_TOP_K=5
- GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
- GATEWAY_DEBUG=true
- GATEWAY_SANDBOX_MODE=off|workspace-write|read-only (default: off)
- GATEWAY_DISABLE_LOCAL_EXECUTION=true (default: false)
- GATEWAY_CONFIRM_TOKEN_TTL_MS=300000
- GATEWAY_AUTO_TOOL_LOOP_ENABLED=true
- GATEWAY_AUTO_TOOL_LOOP_MAX_STEPS=3
- GATEWAY_SESSION_AUTO_COMPACT_ENABLED=true
- GATEWAY_SESSION_AUTO_COMPACT_MAX_ENTRIES=80
`);
}
