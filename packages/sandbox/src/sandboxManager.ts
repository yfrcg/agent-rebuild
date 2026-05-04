import { DockerSandboxBackend } from "./dockerBackend";
import { SandboxAuditLogger } from "./audit";
import { loadSandboxConfig } from "./config";
import { ToolPolicyEngine } from "./policy";
import { WslSandboxBackend } from "./wslBackend";
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxConfig,
  SandboxInspectResult,
  SandboxNetworkMode,
  SandboxProfile,
  SandboxProfileName,
  SandboxRequest,
  SandboxResult,
} from "./types";

export interface SandboxManagerOptions {
  config?: Partial<SandboxConfig>;
  backend?: SandboxBackend;
  policyEngine?: ToolPolicyEngine;
  auditLogger?: SandboxAuditLogger;
}

export class SandboxManager {
  readonly config: SandboxConfig;
  readonly backend: SandboxBackend;
  private readonly policyEngine: ToolPolicyEngine;
  private readonly auditLogger: SandboxAuditLogger;

  constructor(options: SandboxManagerOptions = {}) {
    this.config = loadSandboxConfig(process.env, options.config);
    this.backend =
      options.backend ??
      createSandboxBackend(this.config);
    this.policyEngine = options.policyEngine ?? new ToolPolicyEngine();
    this.auditLogger = options.auditLogger ?? new SandboxAuditLogger(this.config.auditLogPath);
  }

  async exec(request: SandboxRequest): Promise<SandboxResult> {
    const profile = this.getProfile(request.profileName);
    const decision = this.policyEngine.decide(request, profile);
    const baseRecord = {
      time: new Date().toISOString(),
      sessionId: request.sessionId,
      agentId: request.agentId,
      toolName: request.toolName,
      profileName: profile.name,
      backend: this.backend.name,
      command: request.command,
      cwd: request.cwd,
      network: normalizeAuditNetwork(request.networkPolicy, profile.network),
      timeoutMs: request.timeoutMs ?? profile.timeoutMs,
    } as const;

    if (decision.action === "deny") {
      const denied: SandboxResult = {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        deniedReason: decision.reason,
      };
      await this.auditLogger.write({
        ...baseRecord,
        decision: "deny",
        reason: decision.reason,
        sandboxed: false,
        exitCode: denied.exitCode,
        durationMs: denied.durationMs,
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      return denied;
    }

    if (decision.action === "ask") {
      const denied: SandboxResult = {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        deniedReason: "requires human approval",
      };
      await this.auditLogger.write({
        ...baseRecord,
        decision: "ask",
        reason: decision.reason,
        sandboxed: false,
        exitCode: denied.exitCode,
        durationMs: denied.durationMs,
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      return denied;
    }

    const startedAt = Date.now();
    try {
      const result = await this.backend.run(request, profile);
      await this.auditLogger.write({
        ...baseRecord,
        decision: "executed",
        reason: decision.reason,
        sandboxed: true,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      await this.auditLogger.write({
        ...baseRecord,
        decision: "error",
        reason: message,
        sandboxed: true,
        exitCode: null,
        durationMs,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(message, "utf8"),
      });
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: message,
        durationMs,
      };
    }
  }

  async inspect(): Promise<SandboxInspectResult> {
    return {
      config: this.config,
      availability: await this.checkAvailability(),
      profiles: Object.values(this.config.profiles),
    };
  }

  async checkAvailability(): Promise<SandboxAvailability> {
    if (typeof (this.backend as DockerSandboxBackend).checkAvailability === "function") {
      return await (this.backend as DockerSandboxBackend).checkAvailability();
    }

    return {
      ok: true,
      version: this.backend.name,
    };
  }

  private getProfile(profileName: string): SandboxProfile {
    const profile = this.config.profiles[profileName as SandboxProfileName];
    if (!profile) {
      throw new Error(`[sandbox] unknown sandbox profile: ${profileName}`);
    }

    return profile;
  }
}

function normalizeAuditNetwork(
  requested: SandboxRequest["networkPolicy"],
  fallback: SandboxNetworkMode
): SandboxNetworkMode {
  switch (requested) {
    case "enabled":
      return "restricted";
    case "limited":
    case "disabled":
      return "none";
    case "host":
    case "restricted":
    case "none":
      return requested;
    default:
      return fallback;
  }
}

function createSandboxBackend(config: SandboxConfig): SandboxBackend {
  if (config.backend === "remote") {
    return new WslSandboxBackend();
  }

  return new DockerSandboxBackend({
    image: config.dockerImage,
    stdoutLimitBytes: config.maxStdoutBytes,
    stderrLimitBytes: config.maxStderrBytes,
  });
}
