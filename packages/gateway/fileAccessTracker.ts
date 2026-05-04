import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileReadSnapshot {
  path: string;
  mtimeMs: number;
  hash: string;
  sizeBytes: number;
  readAt: string;
}

export interface FileMutationPreflight {
  path: string;
  existed: boolean;
  previousContent?: string;
  previousHash?: string;
  previousSizeBytes?: number;
}

export interface FileMutationSummary {
  path: string;
  changed: boolean;
  summary: string;
  hash: string;
  sizeBytes: number;
}

const DEFAULT_SESSION_KEY = "__default__";
const MAX_TRACKED_FILE_BYTES = 512 * 1024;

export class FileAccessTracker {
  private readonly readsBySession = new Map<string, Map<string, FileReadSnapshot>>();

  recordRead(sessionId: string | undefined, filePath: string): FileReadSnapshot {
    const snapshot = inspectTextFile(filePath);
    const sessionKey = sessionId ?? DEFAULT_SESSION_KEY;
    const sessionReads = this.readsBySession.get(sessionKey) ?? new Map<string, FileReadSnapshot>();
    sessionReads.set(path.resolve(filePath), snapshot);
    this.readsBySession.set(sessionKey, sessionReads);
    return snapshot;
  }

  getReadSnapshot(
    sessionId: string | undefined,
    filePath: string
  ): FileReadSnapshot | undefined {
    return this.readsBySession.get(sessionId ?? DEFAULT_SESSION_KEY)?.get(path.resolve(filePath));
  }

  clearSession(sessionId: string | undefined): void {
    this.readsBySession.delete(sessionId ?? DEFAULT_SESSION_KEY);
  }

  assertCanMutateExistingFile(
    sessionId: string | undefined,
    filePath: string
  ): FileReadSnapshot | undefined {
    const targetPath = path.resolve(filePath);
    if (!fs.existsSync(targetPath)) {
      return undefined;
    }

    const previous = this.getReadSnapshot(sessionId, targetPath);
    if (!previous) {
      throw new Error("You must read this file before editing it.");
    }

    const current = inspectTextFile(targetPath);
    if (current.mtimeMs !== previous.mtimeMs || current.hash !== previous.hash) {
      throw new Error("File changed since last read. Re-read it before editing.");
    }

    return previous;
  }

  capturePreflight(filePath: string): FileMutationPreflight {
    const targetPath = path.resolve(filePath);
    if (!fs.existsSync(targetPath)) {
      return {
        path: targetPath,
        existed: false,
      };
    }

    const snapshot = inspectTextFile(targetPath);
    return {
      path: targetPath,
      existed: true,
      previousContent: fs.readFileSync(targetPath, "utf8"),
      previousHash: snapshot.hash,
      previousSizeBytes: snapshot.sizeBytes,
    };
  }

  finalizeMutation(
    sessionId: string | undefined,
    filePath: string,
    preflight: FileMutationPreflight
  ): FileMutationSummary {
    const targetPath = path.resolve(filePath);
    const after = inspectTextFile(targetPath);
    const currentContent = fs.readFileSync(targetPath, "utf8");
    this.recordRead(sessionId, targetPath);

    return {
      path: targetPath,
      changed:
        !preflight.existed ||
        preflight.previousHash !== after.hash ||
        preflight.previousSizeBytes !== after.sizeBytes,
      hash: after.hash,
      sizeBytes: after.sizeBytes,
      summary: buildDiffSummary(preflight.previousContent, currentContent),
    };
  }
}

export function inspectTextFile(filePath: string): FileReadSnapshot {
  const targetPath = path.resolve(filePath);
  const stat = fs.statSync(targetPath);
  if (stat.size > MAX_TRACKED_FILE_BYTES) {
    throw new Error(`File is too large to edit safely (${stat.size} bytes).`);
  }

  const buffer = fs.readFileSync(targetPath);
  if (buffer.includes(0)) {
    throw new Error("Binary files are not supported by the text editing tools.");
  }

  return {
    path: targetPath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    hash: sha256(buffer),
    readAt: new Date().toISOString(),
  };
}

function buildDiffSummary(previousContent: string | undefined, nextContent: string): string {
  if (previousContent === undefined) {
    const lineCount = countLines(nextContent);
    return `created file (${lineCount} lines, ${nextContent.length} chars)`;
  }

  if (previousContent === nextContent) {
    return "no textual changes";
  }

  const previousLines = previousContent.split(/\r?\n/);
  const nextLines = nextContent.split(/\r?\n/);
  let firstChangedLine = -1;
  const maxLength = Math.max(previousLines.length, nextLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    if (previousLines[index] !== nextLines[index]) {
      firstChangedLine = index + 1;
      break;
    }
  }

  const lineDelta = nextLines.length - previousLines.length;
  return `updated from line ${firstChangedLine === -1 ? 1 : firstChangedLine} (${lineDelta >= 0 ? "+" : ""}${lineDelta} lines, ${nextContent.length - previousContent.length >= 0 ? "+" : ""}${nextContent.length - previousContent.length} chars)`;
}

function countLines(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  return value.split(/\r?\n/).length;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
