/**
 * ?????CS336 ???
 * ???packages/audit/auditLogger.ts
 * ????????
 * ????????????????????????????
 * ???????????????????????????????????? README ????????????????
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "./types";

/**
 * 审计日志器的最小接口。
 *
 * Gateway 不关心日志最终写到文件、数据库还是远端服务，
 * 只要求调用方暴露一个 `log()` 方法即可。
 */
export interface AuditLogger {
  /** 方法 `log`：承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。 */
  log(event: AuditEvent): Promise<void>;
}

/**
 * 将审计事件按 JSONL 形式落盘到本地文件。
 *
 * 每次写入一行 JSON，方便后续用命令行工具、脚本或日志平台做增量消费。
 * 写日志失败时只打印警告，不允许影响主业务链路。
 */
export class FileAuditLogger implements AuditLogger {
  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(private readonly filePath = "logs/gateway-audit.jsonl") {}

  /**
   * 把一条审计事件追加写入日志文件。
   *
   * 这里先确保目录存在，再把事件序列化为单行 JSON，
   * 这样即使日志文件很大，也无需整体重写。
   */
  async log(event: AuditEvent): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });

      const line = JSON.stringify(event) + "\n";
      await appendFile(this.filePath, line, "utf-8");
    } catch (error) {
      console.warn(
        "[audit] failed to write audit log:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
