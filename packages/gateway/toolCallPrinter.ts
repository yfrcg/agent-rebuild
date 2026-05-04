import type { GatewayToolCallRecord } from "./toolCallTypes";

export function printToolCallRecord(record: GatewayToolCallRecord): void {
  const sandboxContent = asSandboxToolContent(record.output?.content);
  const metadata = record.output?.metadata ?? {};

  if (sandboxContent) {
    console.log(`[tool:${record.toolName}]`);
    console.log(`status: ${record.status}`);
    if (record.riskLevel) {
      console.log(`riskLevel: ${record.riskLevel}`);
    }
    console.log(`decision: ${sandboxContent.decision}`);
    console.log(`exitCode: ${sandboxContent.exitCode ?? "null"}`);
    console.log(`durationMs: ${readMetadataNumber(metadata.durationMs) ?? record.durationMs ?? 0}`);
    if (typeof metadata.auditId === "string") {
      console.log(`auditId: ${metadata.auditId}`);
    }
    if (typeof metadata.sandboxId === "string") {
      console.log(`sandboxId: ${metadata.sandboxId}`);
    }
    if (sandboxContent.blockedReason) {
      console.log(`blockedReason: ${sandboxContent.blockedReason}`);
    }
    if (record.error) {
      console.log(`error: ${record.error}`);
    }
    if (sandboxContent.stdout) {
      console.log("\nstdout:");
      console.log(sandboxContent.stdout);
    }
    if (sandboxContent.stderr) {
      console.log("\nstderr:");
      console.log(sandboxContent.stderr);
    }
    if (sandboxContent.artifacts.length > 0) {
      console.log("\nartifacts:");
      sandboxContent.artifacts.forEach((artifact) => {
        console.log(`- ${artifact.path}`);
      });
    }
    return;
  }

  console.log(`[tool-call] id: ${record.id}`);
  console.log(`[tool-call] tool: ${record.toolName}`);
  console.log(`[tool-call] status: ${record.status}`);
  if (record.riskLevel) {
    console.log(`[tool-call] riskLevel: ${record.riskLevel}`);
  }
  console.log(`[tool-call] durationMs: ${record.durationMs ?? 0}`);
  if (record.error) {
    console.log(`[tool-call] error: ${record.error}`);
  }
  console.log("[tool-call] output.metadata:");
  console.log(JSON.stringify(record.output?.metadata ?? {}, null, 2));
  console.log("[tool-call] output.content:");
  console.log(JSON.stringify(record.output?.content ?? null, null, 2));
}

interface SandboxArtifactSummary {
  path: string;
}

interface SandboxToolContent {
  decision: string;
  blockedReason?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  artifacts: SandboxArtifactSummary[];
}

function asSandboxToolContent(value: unknown): SandboxToolContent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.decision !== "string" ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string" ||
    !Array.isArray(candidate.artifacts)
  ) {
    return undefined;
  }

  const artifacts = candidate.artifacts.flatMap((artifact) => {
    if (!artifact || typeof artifact !== "object") {
      return [];
    }

    const item = artifact as Record<string, unknown>;
    return typeof item.path === "string" ? [{ path: item.path }] : [];
  });

  return {
    decision: candidate.decision,
    blockedReason:
      typeof candidate.blockedReason === "string" ? candidate.blockedReason : undefined,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
    exitCode:
      typeof candidate.exitCode === "number" || candidate.exitCode === null
        ? (candidate.exitCode as number | null)
        : null,
    artifacts,
  };
}

function readMetadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
