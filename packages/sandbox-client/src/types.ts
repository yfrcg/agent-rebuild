export type SandboxRunRequest = {
  command: string;
  windowsCwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

export type SandboxRunResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};
