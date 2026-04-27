import type {
  GatewayToolCallCreateInput,
  GatewayToolCallRequest,
} from "./toolCallTypes";

export function createGatewayToolCallId(): string {
  return `toolcall_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createGatewayToolCallRequest(
  input: GatewayToolCallCreateInput
): GatewayToolCallRequest {
  return {
    id: createGatewayToolCallId(),
    toolName: input.toolName,
    input: input.input ?? {},
    sessionId: input.sessionId,
    requestId: input.requestId,
    createdAt: new Date().toISOString(),
  };
}
