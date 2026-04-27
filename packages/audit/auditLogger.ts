import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "./types";

export interface AuditLogger {
  log(event: AuditEvent): Promise<void>;
}

export class FileAuditLogger implements AuditLogger {
  constructor(private readonly filePath = "logs/gateway-audit.jsonl") {}

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