import type {
  GatewayToolCallCreateInput,
  GatewayToolCallRequest,
} from "./toolCallTypes";

/**
 * 生成工具调用唯一 ID。
 *
 * 这个 ID 会被日志、审计和命令行输出复用，
 * 因此格式尽量短且可读。
 */
export function createGatewayToolCallId(): string {
  return `toolcall_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把外部输入封装成标准工具调用请求对象。
 *
 * 这里统一补齐请求 ID、时间戳以及默认的空输入对象，
 * 让执行器拿到的结构始终稳定。
 */
export function createGatewayToolCallRequest(
  input: GatewayToolCallCreateInput
): GatewayToolCallRequest {
  return {
    id: createGatewayToolCallId(),
    name: input.toolName,
    args: input.input ?? {},
    toolName: input.toolName,
    input: input.input ?? {},
    sessionId: input.sessionId,
    requestId: input.requestId,
    approved: input.approved,
    permissionMode: input.permissionMode,
    planState: input.planState,
    createdAt: new Date().toISOString(),
  };
}
