import type { GatewayTool, GatewayToolInput } from "../toolTypes";
import { createToolSecurityProfile } from "../../sandbox/src/policy";

const DEFAULT_PROFILE = "safe-dev";

export function createSandboxedBashTool(projectRoot = process.cwd()): GatewayTool {
  return {
    name: "bash.run",
    description: "Run a shell command through the configured sandbox backend.",
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["sandbox", "bash"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: true,
      allowNetwork: false,
      allowWrite: true,
      allowHostExecution: false,
      requireApproval: false,
    }),
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
        },
        profileName: {
          type: "string",
          enum: ["plan", "safe-dev", "elevated"],
        },
        cwd: {
          type: "string",
        },
        env: {
          type: "object",
        },
        stdin: {
          type: "string",
        },
      },
      required: ["command"],
    },
    sandboxSpec: {
      resolve(input: GatewayToolInput) {
        const command = typeof input.command === "string" ? input.command.trim() : "";
        if (!command) {
          throw new Error("input.command required");
        }

        return {
          profileName:
            typeof input.profileName === "string" && input.profileName.trim().length > 0
              ? input.profileName.trim()
              : DEFAULT_PROFILE,
          command,
          cwd: typeof input.cwd === "string" ? input.cwd : undefined,
          projectRoot,
          env: normalizeEnv(input.env),
          stdin: typeof input.stdin === "string" ? input.stdin : undefined,
        };
      },
    },
    async invoke() {
      return {
        ok: false,
        error: "bash.run must execute through ToolCallExecutor",
      };
    },
  };
}

function normalizeEnv(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && key.trim()) {
      output[key] = value;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}
