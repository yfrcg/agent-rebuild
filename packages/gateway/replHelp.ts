export function printGatewayHelp(): void {
  console.log(`
可用命令：
1. 记住：<内容>
2. 查记忆 <关键词>
3. 读文件 <相对路径>
4. flush
5. recover
6. help
7. exit

普通输入：
- 直接输入一句话，会进入 Gateway v0.1：
  User Input → Gateway → memory.search → contextBuilder → modelProvider → auditLogger → response

配置方式：
- GATEWAY_MODEL=mock
- GATEWAY_MODEL=minimax
- GATEWAY_MEMORY_TOP_K=5
- GATEWAY_AUDIT_LOG_PATH=logs/gateway-audit.jsonl
- GATEWAY_DEBUG=true
`);
}