import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

import type { SandboxAuditRecord } from "./types";

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*)=([^\s]+)/gi;
const SECRET_INLINE_PATTERN =
  /\b(bearer|token|password|secret)\s+([^\s]+)/gi;

export class SandboxAuditLogger {
  constructor(private readonly filePath: string) {}

  async write(record: SandboxAuditRecord): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const sanitized: SandboxAuditRecord = {
        ...record,
        command: sanitizeSecrets(record.command),
      };
      await appendFile(this.filePath, `${JSON.stringify(sanitized)}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sandbox] failed to write audit log: ${message}`);
    }
  }
}

export function sanitizeSecrets(input: string | undefined): string | undefined {
  if (!input) {
    return input;
  }

  return input
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(SECRET_INLINE_PATTERN, (_match, label: string) => `${label} [REDACTED]`);
}
