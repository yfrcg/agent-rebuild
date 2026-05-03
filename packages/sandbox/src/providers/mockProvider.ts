import type { SandboxAvailability } from "../types";
import type {
  SandboxRuntimeExecInput,
  SandboxRuntimeExecOutput,
  SandboxRuntimeProvider,
} from "../runtime";

export class MockRuntimeProvider implements SandboxRuntimeProvider {
  readonly backend = "mock" as const;

  async checkAvailability(): Promise<SandboxAvailability> {
    return {
      ok: true,
      version: "mock-runtime",
    };
  }

  async exec(input: SandboxRuntimeExecInput): Promise<SandboxRuntimeExecOutput> {
    const startedAt = Date.now();
    const commandLine = [input.request.command, ...input.request.args].join(" ").trim();

    return {
      exitCode: 0,
      stdout: [
        "[mock sandbox] no real container isolation",
        `backend=mock`,
        `image=${input.request.image ?? input.session.image}`,
        `workspaceAccess=${input.session.workspaceAccess}`,
        `command=${commandLine}`,
      ].join("\n"),
      stderr: "",
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  }
}
