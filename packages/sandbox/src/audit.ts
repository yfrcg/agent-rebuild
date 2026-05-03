import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { SandboxAuditEvent } from "./types";

export class SandboxAuditLogger {
  constructor(private readonly filePath: string) {}

  async write(event: SandboxAuditEvent): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      console.warn(
        "[sandbox] failed to write sandbox audit log:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

