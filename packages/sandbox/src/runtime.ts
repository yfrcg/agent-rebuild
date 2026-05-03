import { DockerSandboxBackend } from "./dockerBackend";
import type { SandboxAvailability, SandboxBackend, SandboxProfile, SandboxRequest, SandboxResult } from "./types";

export interface SandboxRuntimeExecInput {
  request: SandboxRequest;
  profile: SandboxProfile;
}

export interface SandboxRuntimeExecOutput extends SandboxResult {}

export interface SandboxRuntimeProvider extends SandboxBackend {
  checkAvailability?(): Promise<SandboxAvailability>;
  exec?(input: SandboxRuntimeExecInput): Promise<SandboxRuntimeExecOutput>;
}

export function pickRuntimeProvider(): SandboxRuntimeProvider {
  return new DockerSandboxBackend();
}
