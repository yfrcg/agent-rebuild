import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import type { SandboxWorkspaceAccess } from "./types";

export interface PreparedWorkspace {
  workspaceDir: string;
  mountSource: string;
}

export async function prepareWorkspace(input: {
  rootDir: string;
  tempWorkspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}): Promise<PreparedWorkspace> {
  const rootDir = path.resolve(input.rootDir);
  const tempWorkspaceDir = path.resolve(input.tempWorkspaceDir);

  if (input.workspaceAccess === "none") {
    await mkdir(tempWorkspaceDir, { recursive: true });
    return {
      workspaceDir: tempWorkspaceDir,
      mountSource: tempWorkspaceDir,
    };
  }

  return {
    workspaceDir: rootDir,
    mountSource: rootDir,
  };
}
