import { randomUUID } from "node:crypto";
import type { GatewayRequest } from "./types";

export interface GatewayRequestCreateOptions {
  sessionId?: string;
  userId?: string;
  activeSkills?: string[];
}

/**
 * 把一段纯文本输入包装成标准 Gateway 请求对象。
 *
 * 这里补齐请求 ID 和创建时间，确保后续审计、日志、工具调用链路都能关联到同一请求。
 */
export function createGatewayRequest(
  input: string,
  options: GatewayRequestCreateOptions = {}
): GatewayRequest {
  return {
    id: randomUUID(),
    input: input.trim(),
    sessionId: options.sessionId,
    userId: options.userId,
    activeSkills: options.activeSkills,
    createdAt: new Date().toISOString(),
  };
}
