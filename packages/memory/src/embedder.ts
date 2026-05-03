import "dotenv/config";

type EmbeddingProviderName = "dashscope" | "mock";

/**
 * 从环境变量中读取必填配置项。
 *
 * 这里采用“缺失即抛错”的策略，
 * 避免调用 embedding API 时才发现关键配置根本不存在。
 */
function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

/**
 * 获取当前 embedding 提供商。
 *
 * 默认走真实 DashScope；
 * 显式配置 `EMBEDDING_PROVIDER=mock` 时走离线 deterministic embedding。
 */
export function getEmbeddingProviderName(
  env: NodeJS.ProcessEnv = process.env
): EmbeddingProviderName {
  const provider = env.EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (provider === "mock") {
    return "mock";
  }

  return "dashscope";
}

/**
 * 返回当前 embedding 配置对应的版本键。
 *
 * 这个值会写入 `mem_files.embedder_key`，
 * 便于后续识别索引是由哪种 embedding 方案生成的。
 */
export function getEmbedderKey(env: NodeJS.ProcessEnv = process.env): string {
  const provider = getEmbeddingProviderName(env);
  if (provider === "mock") {
    const dimensions = readDimensions(env, 64);
    return `mock-${dimensions}`;
  }

  return `dashscope-${env.DASHSCOPE_EMBED_MODEL ?? "text-embedding-v4"}`;
}

/**
 * 调用 DashScope 文本嵌入接口，把文本转换成向量。
 *
 * 返回的向量后续会用于：
 * - 语义检索
 * - 相似度计算
 * - 混合搜索排序
 */
export async function embedText(text: string): Promise<number[]> {
  if (getEmbeddingProviderName() === "mock") {
    return deterministicEmbedding(text, readDimensions(process.env, 64));
  }

  const apiKey = getEnv("DASHSCOPE_API_KEY");
  const baseUrl =
    process.env.DASHSCOPE_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = process.env.DASHSCOPE_EMBED_MODEL ?? "text-embedding-v4";
  const dimensions = readDimensions(process.env, 1024);

  const resp = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
      dimensions,
      encoding_format: "float",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DashScope embedding failed: ${resp.status} ${errText}`);
  }

  const data = (await resp.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };

  const embedding = data.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("DashScope embedding response missing vector");
  }

  return embedding;
}

function readDimensions(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.DASHSCOPE_EMBED_DIMENSIONS;
  const parsed = raw ? Number(raw) : fallback;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    vector[index % dimensions] += code / 1024;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => value / norm);
}
