export type SandboxRuntimeBackend = "docker" | "podman" | "mock";
export type SandboxMode = "off" | "untrusted" | "all";
export type SandboxScope = "session" | "call";
export type SandboxWorkspaceAccess = "none" | "copy" | "ro" | "rw";
export type SandboxNetworkPolicy = "none" | "bridge";
export type ToolRiskLevel = "safe" | "low" | "medium" | "high" | "blocked";

export interface SandboxResourceLimits {
  timeoutMs: number;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  maxOutputBytes: number;
  readOnlyRootfs: boolean;
}

export interface SandboxMountPolicy {
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceHostPath: string;
  artifactsHostPath: string;
  readOnlyRootfs: boolean;
}

export interface SandboxEgressProxyConfig {
  enabled: boolean;
  allowDomains: string[];
  blockPrivateIp: boolean;
  logRequests: boolean;
}

export interface SandboxConfig extends SandboxResourceLimits {
  enabled: boolean;
  backend: SandboxRuntimeBackend;
  mode: SandboxMode;
  scope: SandboxScope;
  defaultImage: string;
  network: SandboxNetworkPolicy;
  workspaceAccess: SandboxWorkspaceAccess;
  workRoot: string;
  artifactRoot: string;
  auditLogPath: string;
  requireRuntime: boolean;
  mock: {
    enabled: boolean;
  };
  egressProxy: SandboxEgressProxyConfig;
}

export interface SandboxSession {
  id: string;
  sessionId?: string;
  createdAt: string;
  scope: SandboxScope;
  backend: SandboxRuntimeBackend;
  image: string;
  workspaceDir: string;
  artifactDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}

export interface SandboxInputFile {
  path: string;
  content: string | Buffer;
  encoding?: BufferEncoding;
}

export interface SandboxExecRequest {
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  inputFiles?: SandboxInputFile[];
  timeoutMs?: number;
  network?: SandboxNetworkPolicy;
  image?: string;
  workspaceAccess?: SandboxWorkspaceAccess;
  riskLevel?: ToolRiskLevel;
}

export interface SandboxArtifact {
  path: string;
  absolutePath: string;
  size: number;
}

export interface SandboxExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  artifacts: SandboxArtifact[];
  sandboxId: string;
  auditId: string;
  decision?: "sandbox" | "mock-sandbox" | "blocked" | "error";
  blockedReason?: string;
  error?: string;
  truncatedStdout?: boolean;
  truncatedStderr?: boolean;
}

export interface SandboxAuditEvent {
  auditId: string;
  timestamp: string;
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
  decision: "host" | "sandbox" | "mock-sandbox" | "blocked" | "requireApproval" | "error";
  backend: SandboxRuntimeBackend;
  image: string;
  command: string;
  args: string[];
  cwd?: string;
  envKeys: string[];
  workspaceAccess: SandboxWorkspaceAccess;
  network: SandboxNetworkPolicy;
  mounts: SandboxMountPolicy;
  timeoutMs: number;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  artifacts: string[];
  blockedReason?: string;
  error?: string;
}

export interface ToolSecurityProfile {
  riskLevel: ToolRiskLevel;
  sandboxRequired: boolean;
  allowNetwork: boolean;
  allowWrite: boolean;
  allowHostExecution: boolean;
  requireApproval: boolean;
}

export interface ToolExecutionDecision {
  action: "host" | "sandbox" | "blocked" | "requireApproval";
  reason?: string;
  profile: ToolSecurityProfile;
}

export interface SandboxAvailability {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface SandboxInspectResult {
  config: SandboxConfig;
  availability: SandboxAvailability;
  activeSessions: SandboxSession[];
}

export interface SandboxCleanupResult {
  removedSessionIds: string[];
}
