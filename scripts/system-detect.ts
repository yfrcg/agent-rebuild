import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { FileAuditLogger } from "../packages/audit/auditLogger";
import { GatewayCircuitBreaker } from "../packages/gateway/circuitBreaker";
import { Gateway, type MemorySearch } from "../packages/gateway/gateway";
import { createGatewayMemorySearch } from "../packages/gateway/memoryAdapter";
import { GatewayMetricsCollector } from "../packages/gateway/metricsCollector";
import { GatewayRateLimiter } from "../packages/gateway/rateLimiter";
import { createGatewayRequest } from "../packages/gateway/requestHandler";
import { MiniMaxProvider } from "../packages/model/minimaxProvider";
import { MockModelProvider } from "../packages/model/mockProvider";
import type { ChatMessage, MemorySearchResult as GatewayMemoryResult } from "../packages/gateway/types";
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
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    passRate: string;
  };
  performance: {
    requestCount: number;
    concurrency: number;
    avgDurationMs: number;
    p95DurationMs: number;
    wallClockMs: number;
    achievedTps: number;
    errorRate: number;
  };
  checks: CheckResult[];
}

async function main(): Promise<void> {
  const server = await startMockApiServer();
  const reportPath = path.join(process.cwd(), "logs", "system-detection-report.json");
  const tempMemoryFile = path.join(
    process.cwd(),
    "workspace",
    "memory",
    `system-detect-${Date.now()}.md`
  );
  const auditLogPath = path.join(process.cwd(), "logs", "system-detect-audit.jsonl");

  await mkdir(path.dirname(tempMemoryFile), { recursive: true });
  await mkdir(path.dirname(auditLogPath), { recursive: true });

  const checks: CheckResult[] = [];

  try {
    await withEnv(
      {
        DASHSCOPE_API_KEY: "detect-key",
        DASHSCOPE_BASE_URL: `${server.origin}/compatible-mode/v1`,
      },
      async () => {
        checks.push(await runGatewayUnitChecks());
        checks.push(await runGatewayResilienceChecks());
        checks.push(
          await runApiAdapterChecks(server.origin)
        );
        checks.push(
          await runMemoryReliabilityChecks(tempMemoryFile)
        );
        checks.push(
          await runFullChainChecks(tempMemoryFile, auditLogPath, server.origin)
        );
      }
    );

    const performance = await runGatewayLoadCheck(tempMemoryFile, server.origin);
    const passedChecks = checks.filter((check) => check.passed).length;
    const report: DetectionReport = {
      generatedAt: new Date().toISOString(),
      projectRoot: process.cwd(),
      summary: {
        totalChecks: checks.length,
        passedChecks,
        failedChecks: checks.length - passedChecks,
        passRate: `${((passedChecks / checks.length) * 100).toFixed(1)}%`,
      },
      performance,
      checks,
    };

    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

    console.log("[detect] report written:", reportPath);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await server.close();
    await safeUnlink(tempMemoryFile);
    await safeUnlink(auditLogPath);
  }
}

async function runGatewayUnitChecks(): Promise<CheckResult> {
  const auditEvents: string[] = [];
  const auditLogger = {
    async log(event: { type: string }) {
      auditEvents.push(event.type);
    },
  };

  const successGateway = new Gateway({
    memorySearch: async (query) => [
      {
        id: "mem-1",
        content: `memory for ${query}`,
        score: 1,
        source: "unit",
      },
    ],
    modelProvider: new MockModelProvider(),
    auditLogger,
    debug: true,
  });

  const successResponse = await successGateway.handle(
    createGatewayRequest("gateway success")
  );

  assert.equal(successResponse.error, undefined);
  assert.equal(successResponse.memoryUsed.length, 1);
  assert.equal(successResponse.debug?.hasError, false);

  const memoryFallbackGateway = new Gateway({
    memorySearch: async () => {
      throw new Error("memory down");
    },
    modelProvider: new MockModelProvider(),
    auditLogger,
    debug: true,
  });

  const fallbackResponse = await memoryFallbackGateway.handle(
    createGatewayRequest("gateway fallback")
  );

  assert.equal(fallbackResponse.memoryUsed.length, 0);
  assert.equal(fallbackResponse.debug?.hasError, true);

  const failingModelGateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "failing",
      async generate(_messages: ChatMessage[]) {
        throw new Error("model down");
      },
    },
    auditLogger,
    debug: true,
  });

  const errorResponse = await failingModelGateway.handle(
    createGatewayRequest("gateway model failure")
  );

  assert.match(errorResponse.error ?? "", /model down/);
  assert.equal(errorResponse.debug?.hasError, true);
  assert.ok(
    auditEvents.includes("gateway.request.received") &&
      auditEvents.includes("context.built") &&
      auditEvents.includes("gateway.response.completed")
  );

  return {
    name: "gateway-unit",
    passed: true,
    details: {
      coveredFlows: ["success", "memory-fallback", "model-fallback"],
      auditEventCount: auditEvents.length,
    },
  };
}

async function runGatewayResilienceChecks(): Promise<CheckResult> {
  const auditEvents: string[] = [];
  const auditLogger = {
    async log(event: { type: string }) {
      auditEvents.push(event.type);
    },
  };

  const rateLimiter = new GatewayRateLimiter({
    maxRequests: 2,
    windowMs: 60_000,
  });
  const circuitBreaker = new GatewayCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 50,
  });
  const metricsCollector = new GatewayMetricsCollector({
    maxRtMs: 200,
    maxErrorRate: 0.1,
  });

  const rateLimitedGateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: new MockModelProvider(),
    auditLogger,
    debug: true,
    rateLimiter,
    circuitBreaker,
    metricsCollector,
  });

  const baseRequest = {
    sessionId: "session-rate",
    userId: "user-rate",
  };

  const first = await rateLimitedGateway.handle({
    ...createGatewayRequest("first"),
    ...baseRequest,
  });
  const second = await rateLimitedGateway.handle({
    ...createGatewayRequest("second"),
    ...baseRequest,
  });
  const limited = await rateLimitedGateway.handle({
    ...createGatewayRequest("third"),
    ...baseRequest,
  });

  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(limited.error, "Rate limit exceeded");
  assert.equal(limited.debug?.rateLimit?.allowed, false);
  assert.ok(auditEvents.includes("gateway.rate_limited"));

  const failingGateway = new Gateway({
    memorySearch: async () => [],
    modelProvider: {
      name: "always-fail",
      async generate() {
        throw new Error("upstream unstable");
      },
    },
    auditLogger,
    debug: true,
    circuitBreaker,
    metricsCollector,
  });

  const fail1 = await failingGateway.handle(createGatewayRequest("cb-1"));
  const fail2 = await failingGateway.handle(createGatewayRequest("cb-2"));
  const opened = await failingGateway.handle(createGatewayRequest("cb-3"));

  assert.match(fail1.error ?? "", /upstream unstable/);
  assert.match(fail2.error ?? "", /upstream unstable/);
  assert.equal(opened.error, "Circuit breaker is open");
  assert.equal(opened.debug?.metrics?.circuitState, "open");
  assert.ok(auditEvents.includes("gateway.circuit.open"));
  assert.ok(typeof opened.debug?.metrics?.errorRate === "number");
  assert.ok(typeof opened.debug?.metrics?.p95DurationMs === "number");

  return {
    name: "gateway-resilience",
    passed: true,
    details: {
      coveredFlows: ["rate-limit", "circuit-breaker", "metrics"],
      finalCircuitState: opened.debug?.metrics?.circuitState,
      totalAuditEvents: auditEvents.length,
    },
  };
}

async function runApiAdapterChecks(serverOrigin: string): Promise<CheckResult> {
  const minimaxProvider = new MiniMaxProvider({
    apiKey: "detect-key",
    baseUrl: `${serverOrigin}/v1`,
    model: "detect-ok",
    timeoutMs: 200,
  });

  const minimaxResponse = await minimaxProvider.generate([
    { role: "user", content: "API success" },
  ]);
  assert.match(minimaxResponse.text, /mock minimax response/);

  await assert.rejects(
    () =>
      new MiniMaxProvider({
        apiKey: "detect-key",
        baseUrl: `${serverOrigin}/v1`,
        model: "detect-error",
      }).generate([{ role: "user", content: "server error" }]),
    /MiniMax API request failed/
  );

  await assert.rejects(
    () =>
      new MiniMaxProvider({
        apiKey: "detect-key",
        baseUrl: `${serverOrigin}/v1`,
        model: "detect-timeout",
        timeoutMs: 50,
      }).generate([{ role: "user", content: "timeout" }]),
    /timed out/
  );

  await assert.rejects(
    () =>
      new MiniMaxProvider({
        apiKey: "detect-key",
        baseUrl: `${serverOrigin}/v1`,
        model: "detect-empty",
      }).generate([{ role: "user", content: "empty content" }]),
    /does not contain message content/
  );

  const embedding = await embedText("embedding success");
  assert.equal(embedding.length, 8);

  await withEnv({ DASHSCOPE_API_KEY: "" }, async () => {
    await assert.rejects(() => embedText("missing key"), /Missing env/);
  });

  await assert.rejects(() => embedText("[EMBED:ERROR]"), /DashScope embedding failed/);
  await assert.rejects(() => embedText("[EMBED:EMPTY]"), /response missing vector/);

  return {
    name: "api-adapters",
    passed: true,
    details: {
      coveredAdapters: ["MiniMaxProvider", "embedText"],
      coveredScenarios: [
        "success",
        "http-error",
        "timeout",
        "invalid-payload",
        "missing-config",
      ],
    },
  };
}

async function runMemoryReliabilityChecks(tempMemoryFile: string): Promise<CheckResult> {
  const db = getDb();
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
  assert.ok(backfillResult.updated >= initialState.chunkCount);

  const readyState = getFileState(db, tempMemoryFile);
  assert.equal(readyState.embeddingStatus, "ready");
  assert.equal(readyState.embeddingFilledCount, readyState.embeddingCount);

  await writeFile(
    tempMemoryFile,
    `# system detect\n\n## Notes\n- ${uniqueToken} gamma\n- ${uniqueToken} delta\n`,
    "utf8"
  );

  upsertFileIndex(tempMemoryFile);

  const updatedState = getFileState(db, tempMemoryFile);
  assert.equal(updatedState.embeddingStatus, "pending");
  assert.equal(updatedState.docCount, updatedState.ftsCount);
  assert.equal(updatedState.docCount, updatedState.embeddingCount);
  const removedLegacyChunk = db.prepare(
    "SELECT COUNT(*) AS total FROM mem_docs WHERE file_id = ? AND content LIKE ?"
  ).get(updatedState.fileId, `%${uniqueToken} alpha%`) as { total: number };
  assert.equal(removedLegacyChunk.total, 0);

  await backfillEmbeddings();

  const searchTasks = Array.from({ length: 20 }, () => hybridSearch(uniqueToken, 3));
  const searchResults = await Promise.all(searchTasks);

  assert.equal(searchResults.length, 20);
  assert.ok(searchResults.every((hits) => hits.some((hit) => hit.content.includes(uniqueToken))));

  return {
    name: "memory-reliability",
    passed: true,
    details: {
      uniqueToken,
      initialChunks: initialState.chunkCount,
      updatedChunks: updatedState.chunkCount,
      concurrentQueries: searchTasks.length,
    },
  };
}

async function runFullChainChecks(
  tempMemoryFile: string,
  auditLogPath: string,
  serverOrigin: string
): Promise<CheckResult> {
  const marker = path.basename(tempMemoryFile, ".md");
  const requestText = `请根据 ${marker} 给出摘要`;

  const gateway = new Gateway({
    memorySearch: createGatewayMemorySearch(5),
    modelProvider: new MiniMaxProvider({
      apiKey: "detect-key",
      baseUrl: `${serverOrigin}/v1`,
      model: "detect-ok",
      timeoutMs: 200,
    }),
    auditLogger: new FileAuditLogger(auditLogPath),
    debug: true,
  });

  const response = await gateway.handle(createGatewayRequest(requestText));
  assert.equal(response.error, undefined);
  assert.ok(response.memoryUsed.length > 0);
  assert.ok(response.memoryUsed.some((item) => String(item.source).includes(marker)));
  assert.match(response.text, /mock minimax response/);

  const rawAudit = await readFile(auditLogPath, "utf8");
  const events = rawAudit
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: { durationMs?: number } });

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "gateway.request.received",
      "memory.search.completed",
      "context.built",
      "model.generate.completed",
      "gateway.response.completed",
    ]
  );

  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const durationMs = lastEvent?.data?.durationMs ?? -1;
  assert.ok(durationMs >= 0);

  return {
    name: "full-chain-smoke",
    passed: true,
    details: {
      requestText,
      auditEventCount: events.length,
      durationMs,
    },
  };
}

async function runGatewayLoadCheck(
  tempMemoryFile: string,
  serverOrigin: string
): Promise<DetectionReport["performance"]> {
  const metricsCollector = new GatewayMetricsCollector({
    maxRtMs: 200,
    maxErrorRate: 0.1,
  });
  const gateway = new Gateway({
    memorySearch: createGatewayMemorySearch(3),
    modelProvider: new MiniMaxProvider({
      apiKey: "detect-key",
      baseUrl: `${serverOrigin}/v1`,
      model: "detect-ok",
      timeoutMs: 300,
    }),
    auditLogger: { log: async () => undefined },
    debug: true,
    rateLimiter: new GatewayRateLimiter({
      maxRequests: 10_000,
      windowMs: 60_000,
    }),
    circuitBreaker: new GatewayCircuitBreaker({
      failureThreshold: 50,
      cooldownMs: 1000,
    }),
    metricsCollector,
  });

  const requestCount = 60;
  const concurrency = 12;
  const durations: number[] = [];
  let failures = 0;

  const startedAt = Date.now();

  const workers = Array.from({ length: concurrency }, async (_unused, workerIndex) => {
    for (let index = workerIndex; index < requestCount; index += concurrency) {
      const request = createGatewayRequest(`load-${index} ${path.basename(tempMemoryFile)}`);
      const response = await gateway.handle(request);
      durations.push(response.debug?.durationMs ?? 0);
      if (response.error) {
        failures += 1;
      }
    }
  });

  await Promise.all(workers);

  const wallClockMs = Date.now() - startedAt;
  durations.sort((a, b) => a - b);

  return {
    requestCount,
    concurrency,
    avgDurationMs: round(
      durations.reduce((sum, value) => sum + value, 0) / durations.length
    ),
    p95DurationMs: round(percentile(durations, 0.95)),
    wallClockMs,
    achievedTps: round(requestCount / (wallClockMs / 1000)),
    errorRate: round((failures / requestCount) * 100),
  };
}

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

function round(value: number): number {
  return Number(value.toFixed(2));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

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

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore cleanup failures
  }
}

async function startMockApiServer(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer(async (req, res) => {
    try {
      await handleMockRequest(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function handleMockRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const body = await readJsonBody(req);

  if (req.url === "/v1/chat/completions") {
    const model = String(body.model ?? "");
    if (model === "detect-error") {
      res.statusCode = 500;
      res.end("mock minimax failure");
      return;
    }
    if (model === "detect-timeout") {
      await sleep(120);
    }
    if (model === "detect-empty") {
      writeJson(res, {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
            },
          },
        ],
      });
      return;
    }

    let userMessage: { role?: string; content?: string } | undefined;
    if (Array.isArray(body.messages)) {
      for (let index = body.messages.length - 1; index >= 0; index -= 1) {
        const candidate = body.messages[index] as { role?: string; content?: string };
        if (candidate.role === "user") {
          userMessage = candidate;
          break;
        }
      }
    }

    writeJson(res, {
      choices: [
        {
          message: {
            role: "assistant",
            content: `mock minimax response: ${userMessage?.content ?? "no input"}`,
          },
        },
      ],
    });
    return;
  }

  if (req.url === "/compatible-mode/v1/embeddings") {
    const input = String(body.input ?? "");
    if (input.includes("[EMBED:ERROR]")) {
      res.statusCode = 500;
      res.end("mock embedding failure");
      return;
    }
    if (input.includes("[EMBED:EMPTY]")) {
      writeJson(res, { data: [{}] });
      return;
    }

    writeJson(res, {
      data: [
        {
          embedding: deterministicEmbedding(input),
        },
      ],
    });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function deterministicEmbedding(input: string): number[] {
  const vector = new Array<number>(8).fill(0);
  for (let index = 0; index < input.length; index += 1) {
    vector[index % vector.length] += input.charCodeAt(index) / 1000;
  }
  return vector;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("[detect] failed");
  console.error(error);
  process.exitCode = 1;
});
