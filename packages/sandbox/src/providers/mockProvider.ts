import type { SandboxProfile, SandboxRequest, SandboxResult } from "../types";

export class MockRuntimeProvider {
  readonly name = "mock";

  async run(req: SandboxRequest, profile: SandboxProfile): Promise<SandboxResult> {
    return {
      ok: true,
      exitCode: 0,
      stdout: `[mock sandbox]\nprofile=${profile.name}\ncommand=${req.command ?? ""}`,
      stderr: "",
      durationMs: 0,
    };
  }
}
