export type SandboxProfileName = "plan" | "safe-dev" | "elevated";
export type SandboxNetworkMode = "none" | "restricted" | "host";
export type SandboxRequestedNetworkMode =
  | SandboxNetworkMode
  | "disabled"
  | "limited"
  | "enabled";
export type SandboxWorkspaceAccess = "none" | "ro" | "rw";
export type SandboxBackendName = "docker" | "bubblewrap" | "nsjail" | "remote";
export type PolicyAction = "allow" | "ask" | "deny";

export interface SandboxProfile {
  name: SandboxProfileName;
  network: SandboxNetworkMode;
  workspaceAccess: SandboxWorkspaceAccess;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  requireHumanApproval?: boolean;
}

export interface SandboxRequest {
  sessionId: string;
  agentId?: string;
  profileName: string;
  toolName: string;
  command?: string;
  cwd?: string;
  projectRoot: string;
  env?: Record<string, string>;
  envAllowlist?: string[];
  timeoutMs?: number;
  workspaceMount?: string;
  networkPolicy?: SandboxRequestedNetworkMode;
  resourceLimits?: {
    memoryMb?: number;
    cpus?: number;
    pidsLimit?: number;
    maxOutputBytes?: number;
  };
  stdin?: string;
}

export interface SandboxResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  artifacts?: Array<{
    path: string;
    sizeBytes?: number;
    kind?: string;
    description?: string;
  }>;
  deniedReason?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  matchedRule?: string;
}

export interface SandboxBackend {
  name: SandboxBackendName | string;
  run(req: SandboxRequest, profile: SandboxProfile): Promise<SandboxResult>;
}

export interface SandboxConfig {
  backend: SandboxBackendName;
  dockerImage: string;
  auditLogPath: string;
  profiles: Record<SandboxProfileName, SandboxProfile>;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface SandboxAvailability {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface SandboxInspectResult {
  config: SandboxConfig;
  availability: SandboxAvailability;
  profiles: SandboxProfile[];
}

export interface ToolSecurityProfile {
  riskLevel: "safe" | "low" | "medium" | "high" | "blocked";
  sandboxRequired: boolean;
  allowNetwork: boolean;
  allowWrite: boolean;
  allowHostExecution: boolean;
  requireApproval: boolean;
}

export interface ToolExecutionDecision {
  action: "host" | "sandbox" | "blocked" | "requireApproval";
  reason: string;
  profile: ToolSecurityProfile;
}

export interface SandboxAuditRecord {
  time: string;
  sessionId: string;
  agentId?: string;
  toolName: string;
  profileName: string;
  decision: PolicyAction | "executed" | "error";
  reason: string;
  sandboxed: boolean;
  backend: string;
  command?: string;
  cwd?: string;
  network: SandboxNetworkMode;
  timeoutMs: number;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}
