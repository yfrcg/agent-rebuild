/**
 * ?????CS336 ???
 * ???packages/gateway/ws/auditTail.ts
 * ???WebSocket ????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { redactSecrets } from "./redaction";

/**
 * 审计日志 tail 查询条件。
 *
 * 所有字段都是可选过滤项，`limit` 控制最多返回多少条最近命中的日志。
 */
export interface AuditTailFilter {
  limit?: number;
  type?: string;
  sessionId?: string;
  runId?: string;
  toolName?: string;
}

/**
 * 从本地审计 JSONL 文件读取最近的匹配事件。
 *
 * 函数从文件尾部向前扫描，优先拿到最新日志；每条日志返回前都会做脱敏，
 * 损坏的 JSON 行会被跳过，避免单行异常影响整个 audit.tail 请求。
 */
export function readAuditTail(
  auditLogPath: string,
  filter: AuditTailFilter = {}
): unknown[] {
  const resolved = path.resolve(auditLogPath);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const lines = fs.readFileSync(resolved, "utf8").split(/\r?\n/).filter(Boolean);
  const matched: unknown[] = [];

  for (let index = lines.length - 1; index >= 0 && matched.length < limit; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
      if (!matchesFilter(parsed, filter)) {
        continue;
      }
      matched.push(redactSecrets(parsed));
    } catch {
      // skip corrupted audit lines
    }
  }

  return matched.reverse();
}

/** 判断审计事件是否满足所有过滤条件。 */
function matchesFilter(event: Record<string, unknown>, filter: AuditTailFilter): boolean {
  return (
    matchesField(event, "type", filter.type) &&
    matchesField(event, "sessionId", filter.sessionId) &&
    matchesField(event, "runId", filter.runId) &&
    matchesField(event, "toolName", filter.toolName)
  );
}

/**
 * 匹配顶层字段或 `data` 内部字段。
 *
 * 旧审计事件和新 WS 审计事件的字段可能位于不同层级，
 * 同时兼容两种位置可以让客户端用同一套过滤参数查询。
 */
function matchesField(
  event: Record<string, unknown>,
  field: string,
  expected: string | undefined
): boolean {
  if (!expected) {
    return true;
  }
  if (event[field] === expected) {
    return true;
  }
  const data = event.data;
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>)[field] === expected
  );
}
