import * as path from "node:path";

import { assertInsideWorkspace, isDangerousHostPath } from "../../sandbox/src/pathGuard";
import { createToolSecurityProfile } from "../../sandbox/src/policy";
import type { GatewayTool, GatewayToolInput, GatewayToolOutput } from "../toolTypes";

export function createSandboxedFileTools(projectRoot = process.cwd()): GatewayTool[] {
  return [
    createFileReadTool(projectRoot),
    createFileWriteTool(projectRoot),
    createFileEditTool(projectRoot),
  ];
}

function createFileReadTool(projectRoot: string): GatewayTool {
  return {
    name: "file.read",
    description: "Read a UTF-8 text file inside the project workspace.",
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
    inputSchema: filePathSchema(),
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const target = resolveWorkspacePath(projectRoot, filePath);
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
      const target = resolveWorkspacePath(projectRoot, filePath);
      return {
        ok: false,
        error: "file.read must execute through ToolCallExecutor",
        metadata: {
          path: path.relative(projectRoot, target).replace(/\\/g, "/"),
        },
      };
    },
  };
}

function createFileWriteTool(projectRoot: string): GatewayTool {
  return {
    name: "file.write",
    description: "Write a UTF-8 text file inside the project workspace.",
    policy: {
      automationLevel: "confirm",
      riskLevel: "stateful",
      confirmationMessage: "[tool] file.write requires confirmation before mutating the workspace",
      tags: ["file", "workspace", "write"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: true,
      allowWrite: true,
      allowHostExecution: false,
      requireApproval: true,
    }),
    inputSchema: {
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
    },
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const content = requireString(input.content, "input.content required");
        const target = resolveWorkspacePath(projectRoot, filePath);
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
      const target = resolveWorkspacePath(projectRoot, filePath);
      return successPathOutput(projectRoot, target);
    },
  };
}

function createFileEditTool(projectRoot: string): GatewayTool {
  return {
    name: "file.edit",
    description: "Replace one string occurrence in a UTF-8 text file inside the project workspace.",
    policy: {
      automationLevel: "confirm",
      riskLevel: "stateful",
      confirmationMessage: "[tool] file.edit requires confirmation before mutating the workspace",
      tags: ["file", "workspace", "edit"],
    },
    security: createToolSecurityProfile({
      riskLevel: "medium",
      sandboxRequired: true,
      allowWrite: true,
      allowHostExecution: false,
      requireApproval: true,
    }),
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
        find: {
          type: "string",
        },
        replace: {
          type: "string",
        },
      },
      required: ["path", "find", "replace"],
    },
    sandboxSpec: {
      resolve(input) {
        const filePath = requirePath(input);
        const findText = requireString(input.find, "input.find required");
        const replaceText = requireString(input.replace, "input.replace required");
        const target = resolveWorkspacePath(projectRoot, filePath);
        const containerPath = toContainerPath(projectRoot, target);
        const encodedFind = Buffer.from(findText, "utf8").toString("base64");
        const encodedReplace = Buffer.from(replaceText, "utf8").toString("base64");

        return {
          profileName: "safe-dev",
          projectRoot,
          command: buildNodeCommand([
            "const fs = require('node:fs');",
            `const target = ${JSON.stringify(containerPath)};`,
            "const source = fs.readFileSync(target, 'utf8');",
            `const findText = Buffer.from(${JSON.stringify(encodedFind)}, 'base64').toString('utf8');`,
            `const replaceText = Buffer.from(${JSON.stringify(encodedReplace)}, 'base64').toString('utf8');`,
            "if (!source.includes(findText)) {",
            "  console.error('input.find not found');",
            "  process.exit(1);",
            "}",
            "fs.writeFileSync(target, source.replace(findText, replaceText));",
          ]),
        };
      },
    },
    async invoke(input) {
      const filePath = requirePath(input);
      const target = resolveWorkspacePath(projectRoot, filePath);
      return successPathOutput(projectRoot, target);
    },
  };
}

function resolveWorkspacePath(projectRoot: string, inputPath: string): string {
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
  };
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
    metadata: {
      path: path.relative(projectRoot, target).replace(/\\/g, "/"),
    },
  };
}

function buildNodeCommand(lines: string[]): string {
  return `node - <<'NODE'\n${lines.join("\n")}\nNODE`;
}

function toContainerPath(projectRoot: string, target: string): string {
  const relativePath = path.relative(projectRoot, target).replace(/\\/g, "/");
  return relativePath ? path.posix.join("/workspace", relativePath) : "/workspace";
}
