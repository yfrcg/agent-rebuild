export function printGatewayHelp(): void {
  console.log(`
可用命令：
1. 记住：<内容>
2. 查记忆 <关键词>
3. 读文件 <相对路径>
4. flush
5. recover
6. help
7. :session
8. :session current
9. :session list
10. :session new [name]
11. :session switch <sessionId>
12. :session rename <name>
13. :mcp
14. :mcp status
15. :mcp tools
16. :tools
17. :tool <name> <json>
18. exit

工具说明：
- :mcp / :mcp status 查看 MCP server 连接状态
- :mcp tools 查看 MCP 映射进来的工具
- :tools 列出已注册工具
- :tool memory.search {"query":"Gateway v0.4","topK":5} 通过 Tool Call Protocol 手动调用工具

普通输入：
- 直接输入一句话，会进入 Gateway v0.1：
  User Input → Gateway → memory.search → contextBuilder → modelProvider → auditLogger → response

配置方式：
- GATEWAY_MODEL=mock
- GATEWAY_MODEL=deepseek
- GATEWAY_MEMORY_TOP_K=5
- GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
- GATEWAY_DEBUG=true
`);
}
