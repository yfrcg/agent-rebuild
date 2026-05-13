
import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileAuditLogger } from "../packages/audit/auditLogger";
import { ContextBuilder } from "../packages/gateway/contextBuilder";
import { Gateway } from "../packages/gateway/gateway";
import { createGatewayMemorySearch } from "../packages/gateway/memoryAdapter";
import { GatewayRateLimiter } from "../packages/gateway/rateLimiter";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { MockModelProvider } from "../packages/model/mockProvider";
import { backfillEmbeddings } from "../packages/memory/src/backfillEmbeddings";
import { embedText } from "../packages/memory/src/embedder";
import { hybridSearch } from "../packages/memory/src/hybridSearch";
import { upsertFileIndex } from "../packages/memory/src/memoryIndex";
import { getDb } from "../packages/storage/src/db";

interface CheckResult {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

interface DetectionReport {
  generatedAt: string;
  projectRoot: string;
  mode: "offline";
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    passRate: string;
  };
  checks: CheckResult[];
}

/**
 * 函数 `main` 的职责说明。
 * `main` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function main(): Promise<void> {
  const reportPath = path.join(
    process.cwd(),
    "logs",
    "system-detection-offline-report.json"
  );
  const tempMemoryFile = path.join(
    process.cwd(),
    "workspace",
    "memory",
    `system-detect-offline-${Date.now()}.md`
  );
  const auditLogPath = path.join(process.cwd(), "logs", "runtime", "system-detect-offline-audit.jsonl");

  await mkdir(path.dirname(tempMemoryFile), { recursive: true });
  await mkdir(path.dirname(auditLogPath), { recursive: true });

  const checks: CheckResult[] = [];

  try {
    await withEnv(
      {
        EMBEDDING_PROVIDER: "mock",
        DASHSCOPE_EMBED_DIMENSIONS: "64",
      },
      async () => {
        checks.push(await runBootstrapChecks());
        checks.push(await runApiAdapterChecks());
        checks.push(await runMemoryReliabilityChecks(tempMemoryFile));
        checks.push(await runFullChainChecks(tempMemoryFile, auditLogPath));
        checks.push(await runRateLimitChecks());
      }
    );

    const passedChecks = checks.filter((check) => check.passed).length;
    const report: DetectionReport = {
      generatedAt: new Date().toISOString(),
      projectRoot: process.cwd(),
      mode: "offline",
      summary: {
        totalChecks: checks.length,
        passedChecks,
        failedChecks: checks.length - passedChecks,
        passRate: `${((passedChecks / checks.length) * 100).toFixed(1)}%`,
      },
      checks,
    };

    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    console.log("[detect:offline] report written:", reportPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await safeUnlink(tempMemoryFile);
    await safeUnlink(auditLogPath);
  }
}

/**
 * 函数 `runBootstrapChecks` 的职责说明。
 * `runBootstrapChecks` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function runBootstrapChecks(): Promise<CheckResult> {
  const contextBuilder = new ContextBuilder();
  const messages = contextBuilder.buildMessages("bootstrap probe", []);
  const bootstrapSystemMessage = messages.find(
    (message, index) =>
      index > 0 &&
      message.role === "system" &&
      message.content.includes('<file name="SOUL.md">')
  );

  assert.ok(bootstrapSystemMessage);

  return {
    name: "bootstrap-context",
    passed: true,
    details: {
      messageCount: messages.length,
      injectedFiles: ["SOUL.md", "USER.md", "MEMORY.md"],
    },
  };
}

/**
 * 函数 `runApiAdapterChecks` 的职责说明。
 * `runApiAdapterChecks` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function runApiAdapterChecks(): Promise<CheckResult> {
  const mockProvider = new MockModelProvider();
  const response = await mockProvider.generate([
    { role: "user", content: "Return one short sentence confirming offline API success." },
  ]);

  assert.ok(response.text.includes("offline API success"));

  const embedding = await embedText("offline embedding success");
  assert.ok(Array.isArray(embedding));
  assert.equal(embedding.length, 64);

  return {
    name: "api-adapters-offline",
    passed: true,
    details: {
      modelProvider: "mock",
      responseLength: response.text.length,
      embeddingVectorLength: embedding.length,
    },
  };
}

/**
 * 函数 `runMemoryReliabilityChecks` 的职责说明。
 * `runMemoryReliabilityChecks` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function runMemoryReliabilityChecks(tempMemoryFile: string): Promise<CheckResult> {
  const db = getDb();
  cleanupSystemDetectIndexArtifacts(db, "system-detect-offline-%.md");

  const uniqueToken = `MEM-OFFLINE-${Date.now()}`;
  await writeFile(
    tempMemoryFile,
    `# system detect offline\n\n## Notes\n- ${uniqueToken} alpha\n- ${uniqueToken} beta\n`,
    "utf8"
  );

  upsertFileIndex(tempMemoryFile);
  const initialState = getFileState(db, tempMemoryFile);

  assert.ok(initialState.fileId);
  assert.ok(initialState.chunkCount > 0);
  assert.equal(initialState.docCount, initialState.ftsCount);
  assert.equal(initialState.docCount, initialState.embeddingCount);

  const backfillResult = await backfillEmbeddings();
  const readyState = getFileState(db, tempMemoryFile);

  assert.equal(readyState.embeddingStatus, "ready");
  assert.equal(readyState.embeddingFilledCount, readyState.embeddingCount);

  const hits = await hybridSearch(uniqueToken, 10);
  assert.ok(hits.some((hit) => hit.content.includes(uniqueToken)));

  return {
    name: "memory-reliability-offline",
    passed: true,
    details: {
      uniqueToken,
      initialChunks: initialState.chunkCount,
      embeddingRows: readyState.embeddingFilledCount,
      searchHitCount: hits.length,
      backfillUpdated: backfillResult.updated,
    },
  };
}

/**
 * 函数 `runFullChainChecks` 的职责说明。
 * `runFullChainChecks` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function runFullChainChecks(
  tempMemoryFile: string,
  auditLogPath: string
): Promise<CheckResult> {
  const marker = path.basename(tempMemoryFile, ".md");
  await writeFile(
    tempMemoryFile,
    `# system detect offline\n\n## Notes\n- ${marker} alpha\n- ${marker} beta\n`,
    "utf8"
  );
  upsertFileIndex(tempMemoryFile);
  await backfillEmbeddings();

  const gateway = new Gateway({
    memorySearch: createGatewayMemorySearch(5),
    modelProvider: new MockModelProvider(),
    auditLogger: new FileAuditLogger(auditLogPath),
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest(marker));
  assert.equal(response.error, undefined);
  assert.ok(response.memoryUsed.length > 0);
  assert.ok(response.text.length > 0);

  const rawAudit = await readFile(auditLogPath, "utf8");
  const events = rawAudit
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });

  const eventTypes = events.map((event) => event.type);
  for (const required of [
    "gateway.request.received",
    "memory.search.completed",
    "context.built",
    "model.generate.completed",
    "gateway.response.completed",
  ]) {
    assert.ok(eventTypes.includes(required), `missing audit event: ${required}`);
  }

  return {
    name: "full-chain-offline",
    passed: true,
    details: {
      requestText: marker,
      auditEventCount: events.length,
      memoryHitCount: response.memoryUsed.length,
    },
  };
}

/**
 * 函数 `runRateLimitChecks` 的职责说明。
 * `runRateLimitChecks` 负责执行核心流程，通常会串联校验、状态更新、外部调用和错误处理。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function runRateLimitChecks(): Promise<CheckResult> {
  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new MockModelProvider(),
    debug: true,
    rateLimiter: new GatewayRateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
    }),
  });

  const first = await gateway.handle(createGatewayRequest("rate-limit-first"));
  const second = await gateway.handle(createGatewayRequest("rate-limit-second"));
  const limited = await gateway.handle(createGatewayRequest("rate-limit-third"));

  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(limited.error, "Rate limit exceeded");
  assert.equal(limited.debug?.rateLimit?.allowed, false);

  return {
    name: "rate-limit-offline",
    passed: true,
    details: {
      firstOk: !first.error,
      secondOk: !second.error,
      limitedError: limited.error,
    },
  };
}

/**
 * 函数 `cleanupSystemDetectIndexArtifacts` 的职责说明。
 * `cleanupSystemDetectIndexArtifacts` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function cleanupSystemDetectIndexArtifacts(
  db: ReturnType<typeof getDb>,
  pattern: string
): void {
  const rows = db.prepare("SELECT file_id FROM mem_files WHERE path LIKE ?").all(
    `%${pattern}`
  ) as Array<{ file_id: string }>;

  if (rows.length === 0) {
    return;
  }

  db.exec("BEGIN TRANSACTION");
  try {
    for (const row of rows) {
      const chunkIds = db.prepare("SELECT chunkId FROM mem_docs WHERE file_id = ?").all(
        row.file_id
      ) as Array<{ chunkId: string }>;

      if (chunkIds.length > 0) {
        const ids = chunkIds.map((item) => item.chunkId);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`DELETE FROM mem_embeddings WHERE chunkId IN (${placeholders})`).run(
          ...ids
        );
        db.prepare(`DELETE FROM mem_fts WHERE chunkId IN (${placeholders})`).run(...ids);
      }

      db.prepare("DELETE FROM mem_docs WHERE file_id = ?").run(row.file_id);
      db.prepare("DELETE FROM mem_files WHERE file_id = ?").run(row.file_id);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 函数 `getFileState` 的职责说明。
 * `getFileState` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function getFileState(db: ReturnType<typeof getDb>, filePath: string) {
  const file = db.prepare(
    "SELECT file_id AS fileId, chunk_count AS chunkCount, embedding_status AS embeddingStatus FROM mem_files WHERE path = ?"
  ).get(filePath) as {
    fileId: string;
    chunkCount: number;
    embeddingStatus: string;
  };

  const docCount = (
    db.prepare("SELECT COUNT(*) AS total FROM mem_docs WHERE file_id = ?").get(file.fileId) as {
      total: number;
    }
  ).total;
  const ftsCount = (
    db.prepare("SELECT COUNT(*) AS total FROM mem_fts WHERE file_id = ?").get(file.fileId) as {
      total: number;
    }
  ).total;
  const embeddingCount = (
    db.prepare("SELECT COUNT(*) AS total FROM mem_embeddings WHERE file_id = ?").get(
      file.fileId
    ) as { total: number }
  ).total;
  const embeddingFilledCount = (
    db.prepare(
      "SELECT COUNT(*) AS total FROM mem_embeddings WHERE file_id = ? AND embedding IS NOT NULL AND embedding != ''"
    ).get(file.fileId) as { total: number }
  ).total;

  return {
    fileId: file.fileId,
    chunkCount: file.chunkCount,
    embeddingStatus: file.embeddingStatus,
    docCount,
    ftsCount,
    embeddingCount,
    embeddingFilledCount,
  };
}

/**
 * 函数 `withEnv` 的职责说明。
 * `withEnv` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function withEnv(
  updates: Record<string, string>,
  fn: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * 函数 `safeUnlink` 的职责说明。
 * `safeUnlink` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

main().catch((error) => {
  console.error("[detect:offline] failed");
  console.error(error);
  process.exitCode = 1;
});
