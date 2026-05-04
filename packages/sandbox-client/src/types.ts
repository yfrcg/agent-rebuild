export type SandboxRunRequest = {
  command: string;
  cwd?: string;
  windowsCwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envAllowlist?: string[];
  workspaceMount?: string;
  networkPolicy?: "none" | "restricted" | "host" | "disabled" | "limited" | "enabled";
  resourceLimits?: {
    memoryMb?: number;
    cpus?: number;
    pidsLimit?: number;
    maxOutputBytes?: number;
  };
};

export type SandboxRunResult = {
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
};
