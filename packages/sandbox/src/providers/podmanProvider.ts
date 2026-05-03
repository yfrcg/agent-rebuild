import type { SandboxProfile, SandboxRequest, SandboxResult } from "../types";

export class PodmanSandboxProvider {
  readonly name = "podman";

  async run(_req: SandboxRequest, _profile: SandboxProfile): Promise<SandboxResult> {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "[sandbox] podman backend is reserved for future work",
      durationMs: 0,
    };
  }
}
