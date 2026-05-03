import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { SandboxAuditLogger } from "./audit";
import { loadSandboxConfig } from "./config";
import { findBlockedCommandReason } from "./policy";
import { pickRuntimeProvider, type SandboxRuntimeProvider } from "./runtime";
import type {
  SandboxArtifact,
  SandboxCleanupResult,
  SandboxConfig,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxInspectResult,
  SandboxSession,
  SandboxWorkspaceAccess,
} from "./types";
import { listArtifacts, prepareWorkspace, putSandboxFiles, removeWorkspace } from "./workspace";

export interface SandboxManagerOptions {
  config?: Partial<SandboxConfig>;
  runtimeProvider?: SandboxRuntimeProvider;
}

export class SandboxManager {
  readonly config: SandboxConfig;
  private readonly runtimeProvider: SandboxRuntimeProvider;
  private readonly auditLogger: SandboxAuditLogger;
  private readonly sessions = new Map<string, SandboxSession>();

  constructor(options: SandboxManagerOptions = {}) {
    this.config = loadSandboxConfig(process.env, options.config);
    this.runtimeProvider = options.runtimeProvider ?? pickRuntimeProvider(this.config.backend);
    this.auditLogger = new SandboxAuditLogger(this.config.auditLogPath);
  }

  async createSession(input: {
    sessionId?: string;
    scope?: SandboxConfig["scope"];
    image?: string;
    workspaceAccess?: SandboxWorkspaceAccess;
  } = {}): Promise<SandboxSession> {
    const sandboxId = createSandboxId(input.sessionId);
    const workspaceDir = path.join(this.config.workRoot, sandboxId, "workspace");
    const artifactDir = path.join(this.config.artifactRoot, sandboxId);

    await mkdir(workspaceDir, { recursive: true });
    await mkdir(artifactDir, { recursive: true });

    const session: SandboxSession = {
      id: sandboxId,
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
      scope: input.scope ?? this.config.scope,
      backend: this.config.backend,
      image: input.image ?? this.config.defaultImage,
      workspaceDir,
      artifactDir,
      workspaceAccess: input.workspaceAccess ?? this.config.workspaceAccess,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const session =
      this.config.scope === "session" && request.sessionId
        ? await this.getOrCreateSession(request.sessionId, request)
        : await this.createSession({
            sessionId: request.sessionId,
            scope: "call",
            image: request.image,
            workspaceAccess: request.workspaceAccess,
          });

    const workspaceAccess = request.workspaceAccess ?? this.config.workspaceAccess;
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const image = request.image ?? session.image;
    const auditId = createAuditId(request.toolCallId);
    const blockedReason = findBlockedCommandReason(request);
    const envKeys = Object.keys(request.env ?? {});

    if (blockedReason) {
      await this.auditLogger.write({
        auditId,
        timestamp: new Date().toISOString(),
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        riskLevel: request.riskLevel ?? "high",
        decision: "blocked",
        backend: this.config.backend,
        image,
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        envKeys,
        workspaceAccess,
        network: request.network ?? this.config.network,
        mounts: {
          workspaceAccess,
          workspaceHostPath: session.workspaceDir,
          artifactsHostPath: session.artifactDir,
          readOnlyRootfs: this.config.readOnlyRootfs,
        },
        timeoutMs,
        memoryLimit: this.config.memoryLimit,
        cpuLimit: this.config.cpuLimit,
        pidsLimit: this.config.pidsLimit,
        artifacts: [],
        blockedReason,
      });

      return {
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 0,
        artifacts: [],
        sandboxId: session.id,
        auditId,
        decision: "blocked",
        blockedReason,
        error: `[sandbox] blocked command: ${blockedReason}`,
      };
    }

    const preparedWorkspace = await prepareWorkspace({
      rootDir: request.cwd ? path.resolve(process.cwd(), request.cwd) : process.cwd(),
      tempWorkspaceDir: session.workspaceDir,
      workspaceAccess,
    });

    if (request.inputFiles && request.inputFiles.length > 0) {
      await putSandboxFiles(preparedWorkspace.workspaceDir, request.inputFiles);
    }

    const availability = await this.runtimeProvider.checkAvailability();
    if (!availability.ok) {
      await this.auditLogger.write({
        auditId,
        timestamp: new Date().toISOString(),
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        riskLevel: request.riskLevel ?? "high",
        decision: "error",
        backend: this.config.backend,
        image,
        command: request.command,
        args: request.args,
        cwd: request.cwd,
        envKeys,
        workspaceAccess,
        network: request.network ?? this.config.network,
        mounts: {
          workspaceAccess,
          workspaceHostPath: preparedWorkspace.mountSource,
          artifactsHostPath: session.artifactDir,
          readOnlyRootfs: this.config.readOnlyRootfs,
        },
        timeoutMs,
        memoryLimit: this.config.memoryLimit,
        cpuLimit: this.config.cpuLimit,
        pidsLimit: this.config.pidsLimit,
        artifacts: [],
        error: availability.error,
      });

      return {
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        durationMs: 0,
        artifacts: [],
        sandboxId: session.id,
        auditId,
        decision: "error",
        error: availability.error ?? `[sandbox] ${this.config.backend} runtime is unavailable`,
      };
    }

    const runtimeResult = await this.runtimeProvider.exec({
      config: this.config,
      session: {
        ...session,
        image,
        workspaceAccess,
      },
      request: {
        ...request,
        image,
        timeoutMs,
        network: resolveNetwork(this.config, request),
      },
      workspaceHostPath: preparedWorkspace.mountSource,
      artifactHostPath: session.artifactDir,
    });

    const artifacts = await this.listArtifacts(session.id);
    const stdout = truncateOutput(runtimeResult.stdout, this.config.maxOutputBytes);
    const stderr = truncateOutput(runtimeResult.stderr, this.config.maxOutputBytes);

    await this.auditLogger.write({
      auditId,
      timestamp: new Date().toISOString(),
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      riskLevel: request.riskLevel ?? "high",
      decision: "sandbox",
      backend: this.config.backend,
      image,
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      envKeys,
      workspaceAccess,
      network: resolveNetwork(this.config, request),
      mounts: {
        workspaceAccess,
        workspaceHostPath: preparedWorkspace.mountSource,
        artifactsHostPath: session.artifactDir,
        readOnlyRootfs: this.config.readOnlyRootfs,
      },
      timeoutMs,
      memoryLimit: this.config.memoryLimit,
      cpuLimit: this.config.cpuLimit,
      pidsLimit: this.config.pidsLimit,
      exitCode: runtimeResult.exitCode,
      timedOut: runtimeResult.timedOut,
      durationMs: runtimeResult.durationMs,
      stdoutBytes: Buffer.byteLength(runtimeResult.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(runtimeResult.stderr, "utf8"),
      artifacts: artifacts.map((artifact) => artifact.path),
      error: runtimeResult.error,
    });

    if (session.scope === "call") {
      await removeWorkspace(session.workspaceDir);
      this.sessions.delete(session.id);
    }

    return {
      ok: runtimeResult.exitCode === 0 && !runtimeResult.error,
      exitCode: runtimeResult.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      timedOut: runtimeResult.timedOut,
      durationMs: runtimeResult.durationMs,
      artifacts,
      sandboxId: session.id,
      auditId,
      decision: "sandbox",
      error: runtimeResult.error,
      truncatedStdout: stdout.truncated,
      truncatedStderr: stderr.truncated,
    };
  }

  async destroySession(sandboxId: string): Promise<void> {
    const session = this.sessions.get(sandboxId);
    if (!session) {
      return;
    }

    await removeWorkspace(session.workspaceDir);
    this.sessions.delete(sandboxId);
  }

  async putFiles(
    sandboxId: string,
    files: SandboxExecRequest["inputFiles"]
  ): Promise<void> {
    if (!files || files.length === 0) {
      return;
    }

    const session = this.sessions.get(sandboxId);
    if (!session) {
      throw new Error(`[sandbox] unknown session: ${sandboxId}`);
    }

    await putSandboxFiles(session.workspaceDir, files);
  }

  async listArtifacts(sandboxId: string): Promise<SandboxArtifact[]> {
    const session = this.sessions.get(sandboxId);
    const artifactDir = session?.artifactDir ?? path.join(this.config.artifactRoot, sandboxId);
    return listArtifacts(artifactDir);
  }

  async cleanupExpired(maxAgeMs = 24 * 60 * 60 * 1000): Promise<SandboxCleanupResult> {
    const now = Date.now();
    const removedSessionIds: string[] = [];

    for (const [sandboxId, session] of this.sessions.entries()) {
      if (now - Date.parse(session.createdAt) < maxAgeMs) {
        continue;
      }

      await this.destroySession(sandboxId);
      removedSessionIds.push(sandboxId);
    }

    return { removedSessionIds };
  }

  async inspect(): Promise<SandboxInspectResult> {
    return {
      config: this.config,
      availability: await this.runtimeProvider.checkAvailability(),
      activeSessions: Array.from(this.sessions.values()),
    };
  }

  private async getOrCreateSession(
    sessionId: string,
    request: Pick<SandboxExecRequest, "image" | "workspaceAccess">
  ): Promise<SandboxSession> {
    const existing = Array.from(this.sessions.values()).find(
      (session) => session.sessionId === sessionId
    );
    if (existing) {
      return existing;
    }

    return this.createSession({
      sessionId,
      scope: "session",
      image: request.image,
      workspaceAccess: request.workspaceAccess,
    });
  }
}

function createSandboxId(sessionId?: string): string {
  const prefix = sessionId?.trim() ? sessionId.replace(/[^a-zA-Z0-9_-]/g, "-") : "sandbox";
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAuditId(toolCallId: string): string {
  return `${toolCallId}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveNetwork(config: SandboxConfig, request: SandboxExecRequest) {
  if (request.network === "bridge") {
    return "bridge";
  }

  return config.network;
}

function truncateOutput(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  const size = Buffer.byteLength(value, "utf8");
  if (size <= maxBytes) {
    return {
      value,
      truncated: false,
    };
  }

  const suffix = "\n[truncated]";
  const trimmedBuffer = Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8")));
  return {
    value: trimmedBuffer.toString("utf8") + suffix,
    truncated: true,
  };
}
