import * as path from "node:path";

import { resolveProjectRoot } from "../../core/src/config";
import { assertInsideWorkspace, isDangerousHostPath } from "../../sandbox/src/pathGuard";
import { createToolSecurityProfile } from "../../sandbox/src/policy";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

export function createSandboxedFileTools(projectRoot = resolveProjectRoot()): GatewayTool[] {
  return [
    createFileReadTool(projectRoot),
    createFileWriteTool(projectRoot),
    createFileEditTool(projectRoot),
    createFileListTool(projectRoot),
  ];
}

function createFileReadTool(projectRoot: string): GatewayTool {
  const schema = filePathSchema();

  return {
    name: "file.read",
    description: "Read a UTF-8 text file inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: true,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["file", "workspace", "read"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: true,
      allowHostExecution: false,
      allowWrite: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `process.stdout.write(fs.readFileSync(${JSON.stringify(containerPath)}, 'utf8'));`,
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return {
        ok: false,
        error: "file.read must execute through ToolCallExecutor",
        metadata: {
          path: relativeWorkspacePath(projectRoot, target),
        },
      };
    },
  };
}

function createFileWriteTool(projectRoot: string): GatewayTool {
  const schema = {
    ...filePathSchema(),
    properties: {
      path: {
        type: "string",
      },
      content: {
        type: "string",
      },
    },
    required: ["path", "content"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.write",
    description: "Write a UTF-8 text file inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: true,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["file", "workspace", "write"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: true,
      allowWrite: true,
      allowHostExecution: false,
      requireApproval: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const content = requireString(input.content, "input.content required");
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);
        const encoded = Buffer.from(content, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            `const target = ${JSON.stringify(containerPath)};`,
            `const content = Buffer.from(${JSON.stringify(encoded)}, 'base64');`,
            "fs.mkdirSync(path.dirname(target), { recursive: true });",
            "fs.writeFileSync(target, content);",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return successPathOutput(projectRoot, target);
    },
  };
}

function createFileEditTool(projectRoot: string): GatewayTool {
  const schema = {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
      oldText: {
        type: "string",
      },
      newText: {
        type: "string",
      },
      find: {
        type: "string",
      },
      replace: {
        type: "string",
      },
    },
    required: ["path"],
  } satisfies Record<string, unknown>;

  return {
    name: "file.edit",
    description: "Replace one string occurrence in a UTF-8 text file inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "medium",
    permissionLevel: "write",
    readOnly: false,
    sideEffect: true,
    requiresSandbox: true,
    policy: {
      automationLevel: "auto",
      riskLevel: "stateful",
      tags: ["file", "workspace", "edit"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: true,
      allowWrite: true,
      allowHostExecution: false,
      requireApproval: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const oldText = requireString(
          input.oldText ?? input.find,
          "input.oldText required"
        );
        const newText = requireString(
          input.newText ?? input.replace,
          "input.newText required"
        );
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);
        const encodedOld = Buffer.from(oldText, "utf8").toString("base64");
        const encodedNew = Buffer.from(newText, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `const target = ${JSON.stringify(containerPath)};`,
            "const source = fs.readFileSync(target, 'utf8');",
            `const oldText = Buffer.from(${JSON.stringify(encodedOld)}, 'base64').toString('utf8');`,
            `const newText = Buffer.from(${JSON.stringify(encodedNew)}, 'base64').toString('utf8');`,
            "if (!source.includes(oldText)) {",
            "  console.error('input.oldText not found');",
            "  process.exit(1);",
            "}",
            "fs.writeFileSync(target, source.replace(oldText, newText));",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return successPathOutput(projectRoot, target);
    },
  };
}

function createFileListTool(projectRoot: string): GatewayTool {
  const schema = filePathSchema();

  return {
    name: "file.list",
    description: "List files and directories inside the project workspace.",
    schema,
    inputSchema: schema,
    riskLevel: "safe",
    permissionLevel: "read",
    readOnly: true,
    sideEffect: false,
    requiresSandbox: true,
    policy: {
      automationLevel: "auto",
      riskLevel: "read-only",
      tags: ["file", "workspace", "list"],
    },
    security: createToolSecurityProfile({
      riskLevel: "safe",
      sandboxRequired: true,
      allowHostExecution: false,
      allowWrite: false,
    }),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const target = resolveWorkspaceTarget(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `const target = ${JSON.stringify(containerPath)};`,
            "const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({",
            "  name: entry.name,",
            "  type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'",
            "}));",
            "process.stdout.write(JSON.stringify(entries, null, 2));",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspaceTarget(projectRoot, filePath);
      return {
        ok: false,
        error: "file.list must execute through ToolCallExecutor",
        metadata: {
          path: relativeWorkspacePath(projectRoot, target),
        },
      };
    },
  };
}

function resolveWorkspaceTarget(projectRoot: string, inputPath: string): string {
  const target = path.resolve(projectRoot, inputPath);
  assertInsideWorkspace(target, projectRoot);
  if (isDangerousHostPath(target)) {
    throw new Error(`[tool] blocked dangerous path: ${inputPath}`);
  }

  return target;
}

function filePathSchema() {
  return {
    type: "object",
    properties: {
      path: {
        type: "string",
      },
    },
    required: ["path"],
  } satisfies Record<string, unknown>;
}

function requirePath(input: GatewayToolInput): string {
  return requireString(input.path, "input.path required");
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value;
}

function successPathOutput(projectRoot: string, target: string): GatewayToolOutput {
  return {
    ok: true,
    content: {
      path: relativeWorkspacePath(projectRoot, target),
    },
    metadata: {
      path: relativeWorkspacePath(projectRoot, target),
    },
  };
}

function buildNodeCommand(lines: string[]): string {
  return `node - <<'NODE'\n${lines.join("\n")}\nNODE`;
}

function toContainerPath(projectRoot: string, target: string): string {
  const relativePath = relativeWorkspacePath(projectRoot, target);
  return relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
}

function relativeWorkspacePath(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).replace(/\\/g, "/");
}
