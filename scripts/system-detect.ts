
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
import { TokenPlanProvider } from "../packages/model/tokenPlanProvider";
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
  mode: "live-only";
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    passRate: string;
  };
  checks: CheckResult[];
}

/**
 * 运行整套系统探测，并把结果输出为 JSON 报告。
 *
 * 该脚本关注的是“真实系统是否可用”，因此会实际执行：
 * - bootstrap 注入检查
 * - 模型与 embedding API 调用
 * - 记忆索引与检索链路
 * - Gateway 全链路
 * - 限流逻辑
 */
async function main(): Promise<void> {
  const reportPath = path.join(process.cwd(), "logs", "system-detection-report.json");
  const tempMemoryFile = path.join(
    process.cwd(),
    "workspace",
    "memory",
    `system-detect-${Date.now()}.md`
  );
  const auditLogPath = path.join(process.cwd(), "logs", "runtime", "system-detect-audit.jsonl");

  await mkdir(path.dirname(tempMemoryFile), { recursive: true });
  await mkdir(path.dirname(auditLogPath), { recursive: true });

  const checks: CheckResult[] = [];

  try {
    checks.push(await runBootstrapChecks());
    checks.push(await runApiAdapterChecks());
    checks.push(await runMemoryReliabilityChecks(tempMemoryFile));
    checks.push(await runFullChainChecks(tempMemoryFile, auditLogPath));
    checks.push(await runRateLimitChecks());

    const passedChecks = checks.filter((check) => check.passed).length;
    const report: DetectionReport = {
      generatedAt: new Date().toISOString(),
      projectRoot: process.cwd(),
      mode: "live-only",
      summary: {
        totalChecks: checks.length,
        passedChecks,
        failedChecks: checks.length - passedChecks,
        passRate: `${((passedChecks / checks.length) * 100).toFixed(1)}%`,
      },
      checks,
    };

    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    console.log("[detect] report written:", reportPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await safeUnlink(tempMemoryFile);
    await safeUnlink(auditLogPath);
  }
}

/**
 * 检查 bootstrap 上下文是否被正确注入到消息数组中。
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
 * 检查模型与 embedding 两个外部 API 适配器是否可正常工作。
 */
async function runApiAdapterChecks(): Promise<CheckResult> {
  const tokenPlanProvider = new TokenPlanProvider({ timeoutMs: 60_000 });
  const tokenPlanResponse = await tokenPlanProvider.generate([
    { role: "user", content: "Return one short sentence confirming live API success." },
  ]);

  assert.ok(tokenPlanResponse.text.trim().length > 0);

  const embedding = await embedText("embedding success");
  assert.ok(Array.isArray(embedding));
  assert.ok(embedding.length > 0);

  return {
    name: "api-adapters-live",
    passed: true,
    details: {
      modelProvider: "tokenplan",
      tokenPlanResponseLength: tokenPlanResponse.text.length,
      embeddingVectorLength: embedding.length,
    },
  };
}

/**
 * 检查记忆系统的可靠性。
 *
 * 这里会临时写入一份记忆文件，随后验证：
 * - 是否成功建索引
 * - 是否成功生成 embedding
 * - 是否可以通过混合检索查回
 */
async function runMemoryReliabilityChecks(tempMemoryFile: string): Promise<CheckResult> {
  const db = getDb();
  cleanupSystemDetectIndexArtifacts(db);

  const uniqueToken = `MEM-${Date.now()}`;
  await writeFile(
    tempMemoryFile,
    `# system detect\n\n## Notes\n- ${uniqueToken} alpha\n- ${uniqueToken} beta\n`,
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
    name: "memory-reliability-live",
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
 * 检查 Gateway 从“记忆检索 -> 上下文构建 -> 模型回复 -> 审计日志”的完整链路。
 */
async function runFullChainChecks(
  tempMemoryFile: string,
  auditLogPath: string
): Promise<CheckResult> {
  const marker = path.basename(tempMemoryFile, ".md");
  await writeFile(
    tempMemoryFile,
    `# system detect\n\n## Notes\n- ${marker} alpha\n- ${marker} beta\n`,
    "utf8"
  );
  upsertFileIndex(tempMemoryFile);
  await backfillEmbeddings();

  const gateway = new Gateway({
    memorySearch: createGatewayMemorySearch(5),
    modelProvider: new TokenPlanProvider({ timeoutMs: 60_000 }),
    auditLogger: new FileAuditLogger(auditLogPath),
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest(marker));
  assert.equal(response.error, undefined);
  assert.ok(response.memoryUsed.length > 0);
  assert.ok(response.memoryUsed.some((item) => String(item.source).includes(marker)));
  assert.ok(response.text.trim().length > 0);

  let fallbackWithoutEmbeddingsMemoryCount = 0;
  await withEnv({ DASHSCOPE_API_KEY: "" }, async () => {
    const fallbackGateway = new Gateway({
      memorySearch: createGatewayMemorySearch(5),
      modelProvider: new TokenPlanProvider({ timeoutMs: 60_000 }),
      debug: true,
    });

    const fallbackResponse = await fallbackGateway.handle(createGatewayRequest(marker));
    fallbackWithoutEmbeddingsMemoryCount = fallbackResponse.memoryUsed.length;

    assert.equal(fallbackResponse.error, undefined);
    assert.ok(fallbackResponse.memoryUsed.length > 0);
  });

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
    name: "full-chain-live",
    passed: true,
    details: {
      requestText: marker,
      auditEventCount: events.length,
      memoryHitCount: response.memoryUsed.length,
      fallbackWithoutEmbeddingsMemoryCount,
    },
  };
}

/**
 * 检查限流逻辑是否按阈值生效。
 */
async function runRateLimitChecks(): Promise<CheckResult> {
  const gateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new TokenPlanProvider({ timeoutMs: 60_000 }),
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
    name: "rate-limit-live",
    passed: true,
    details: {
      firstOk: !first.error,
      secondOk: !second.error,
      limitedError: limited.error,
    },
  };
}

/**
 * 清理此前 system-detect 生成过的索引残留。
 *
 * 避免旧测试数据影响本次探测结论。
 */
function cleanupSystemDetectIndexArtifacts(db: ReturnType<typeof getDb>): void {
  const rows = db.prepare("SELECT file_id FROM mem_files WHERE path LIKE ?").all(
    "%system-detect-%.md"
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
 * 查询某个测试文件当前在索引系统中的状态。
 *
 * 返回内容包括：
 * - 文件级状态
 * - docs / fts / embeddings 的行数
 * - 已填充 embedding 的数量
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
 * 临时覆盖环境变量执行一段异步逻辑，并在结束后恢复原值。
 *
 * 这个工具函数主要用于模拟“某些外部能力不可用”的退化场景。
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
 * 安全删除临时文件。
 *
 * 清理失败不会影响主结果，因此这里选择静默吞掉异常。
 */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

main().catch((error) => {
  console.error("[detect] failed");
  console.error(error);
  process.exitCode = 1;
});
