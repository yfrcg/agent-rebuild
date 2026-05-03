import * as path from "node:path";

import { WslSandboxClient } from "../../sandbox-client/src";
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxProfile,
  SandboxRequest,
  SandboxResult,
} from "./types";

export interface WslSandboxBackendOptions {
  client?: WslSandboxClient;
}

export class WslSandboxBackend implements SandboxBackend {
  readonly name = "remote";
  private readonly client: WslSandboxClient;

  constructor(options: WslSandboxBackendOptions = {}) {
    this.client = options.client ?? new WslSandboxClient();
  }

  async checkAvailability(): Promise<SandboxAvailability> {
    const result = await this.client.health();
    return {
      ok: result.ok,
      version: result.ok ? "wsl-worker" : undefined,
      error: result.ok ? undefined : result.body || "WSL sandbox worker unavailable",
    };
  }

  async run(req: SandboxRequest, profile: SandboxProfile): Promise<SandboxResult> {
    const result = await this.client.run({
      command: req.command?.trim() || "true",
      windowsCwd: resolveWindowsCwd(req),
      timeoutMs: profile.timeoutMs,
      env: req.env,
    });

    return {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    };
  }
}

function resolveWindowsCwd(req: SandboxRequest): string {
  const projectRoot = path.resolve(req.projectRoot);
  const cwd = req.cwd ? path.resolve(projectRoot, req.cwd) : projectRoot;
  return cwd;
}
