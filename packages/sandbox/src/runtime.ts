import { spawn } from "node:child_process";

import type {
  SandboxAvailability,
  SandboxConfig,
  SandboxExecRequest,
  SandboxMountPolicy,
  SandboxNetworkPolicy,
  SandboxRuntimeBackend,
  SandboxSession,
} from "./types";

export interface SandboxRuntimeExecInput {
  config: SandboxConfig;
  session: SandboxSession;
  request: SandboxExecRequest;
  workspaceHostPath: string;
  artifactHostPath: string;
}

export interface SandboxRuntimeExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface SandboxRuntimeProvider {
  readonly backend: SandboxRuntimeBackend;
  checkAvailability(): Promise<SandboxAvailability>;
  exec(input: SandboxRuntimeExecInput): Promise<SandboxRuntimeExecOutput>;
}

export abstract class ContainerCliRuntimeProvider implements SandboxRuntimeProvider {
  abstract readonly backend: SandboxRuntimeBackend;
  protected abstract readonly command: string;

  async checkAvailability(): Promise<SandboxAvailability> {
    const result = await spawnProcess(this.command, ["--version"], 10_000);
    if (result.error) {
      return {
        ok: false,
        error: result.error,
      };
    }

    return {
      ok: result.exitCode === 0,
      version: firstNonEmptyLine(result.stdout || result.stderr),
      error: result.exitCode === 0 ? undefined : firstNonEmptyLine(result.stderr),
    };
  }

  async exec(input: SandboxRuntimeExecInput): Promise<SandboxRuntimeExecOutput> {
    const args = this.buildRunArgs(input);
    return spawnProcess(this.command, args, input.request.timeoutMs ?? input.config.timeoutMs);
  }

  protected buildRunArgs(input: SandboxRuntimeExecInput): string[] {
    const mountPolicy = buildMountPolicy(input);
    assertSafeMountPath(mountPolicy.workspaceHostPath, "workspace");
    assertSafeMountPath(mountPolicy.artifactsHostPath, "artifacts");

    const args: string[] = [
      "run",
      "--rm",
      "--network",
      resolveNetwork(input.config.network, input.request.network, input.request),
      "--memory",
      input.config.memoryLimit,
      "--cpus",
      input.config.cpuLimit,
      "--pids-limit",
      String(input.config.pidsLimit),
      "--user",
      "1000:1000",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--workdir",
      "/workspace",
      "-v",
      `${mountPolicy.workspaceHostPath}:/workspace${mountPolicy.workspaceAccess === "ro" ? ":ro" : ""}`,
      "-v",
      `${mountPolicy.artifactsHostPath}:/artifacts`,
    ];

    if (input.config.readOnlyRootfs) {
      args.push("--read-only", "--tmpfs", "/tmp", "--tmpfs", "/home/agent");
    }

    const envEntries = Object.entries(input.request.env ?? {}).filter(
      ([key]) => key.trim().length > 0
    );
    for (const [key, value] of envEntries) {
      args.push("-e", `${key}=${value}`);
    }

    args.push(input.request.image ?? input.session.image);
    args.push(input.request.command, ...input.request.args);

    return args;
  }
}

export function pickRuntimeProvider(backend: SandboxRuntimeBackend): SandboxRuntimeProvider {
  switch (backend) {
    case "docker": {
      const { DockerSandboxProvider } = require("./providers/dockerProvider") as typeof import("./providers/dockerProvider");
      return new DockerSandboxProvider();
    }
    case "podman": {
      const { PodmanSandboxProvider } = require("./providers/podmanProvider") as typeof import("./providers/podmanProvider");
      return new PodmanSandboxProvider();
    }
  }
}

export async function spawnProcess(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<SandboxRuntimeExecOutput> {
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      env: pickHostProcessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        error: friendlyRuntimeError(command, error),
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: typeof code === "number" ? code : -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function buildMountPolicy(input: SandboxRuntimeExecInput): SandboxMountPolicy {
  return {
    workspaceAccess: input.session.workspaceAccess,
    workspaceHostPath: input.workspaceHostPath,
    artifactsHostPath: input.artifactHostPath,
    readOnlyRootfs: input.config.readOnlyRootfs,
  };
}

function resolveNetwork(
  defaultNetwork: SandboxNetworkPolicy,
  requestedNetwork: SandboxNetworkPolicy | undefined,
  request: SandboxExecRequest
): SandboxNetworkPolicy {
  if (request.network === "bridge") {
    return "bridge";
  }

  return requestedNetwork ?? defaultNetwork;
}

function assertSafeMountPath(hostPath: string, label: string): void {
  const normalized = hostPath.replace(/\\/g, "/").toLowerCase();
  const forbiddenSnippets = [
    "/.ssh",
    "/.aws",
    "/.docker",
    "/.config",
    "/var/run/docker.sock",
    "/proc",
    "/sys",
    "/dev",
    "/etc",
  ];

  if (!normalized || normalized === "/" || /^[a-z]:\/?$/.test(normalized)) {
    throw new Error(`[sandbox] refusing to mount host ${label} path: ${hostPath}`);
  }

  if (forbiddenSnippets.some((snippet) => normalized.includes(snippet))) {
    throw new Error(`[sandbox] refusing to mount sensitive host ${label} path: ${hostPath}`);
  }
}

function pickHostProcessEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "COMSPEC",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "TMP",
    "TEMP",
  ];

  return allowedKeys.reduce<NodeJS.ProcessEnv>((acc, key) => {
    const value = process.env[key];
    if (typeof value === "string") {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function friendlyRuntimeError(command: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOENT")) {
    return `[sandbox] runtime backend command not found: ${command}`;
  }
  return `[sandbox] runtime backend failed: ${message}`;
}

function firstNonEmptyLine(input: string): string | undefined {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

