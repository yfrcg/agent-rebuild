import "dotenv/config";

/**
 * 从环境变量中读取指定名称的配置值。
 * 若变量未设置或值为空，则抛出明确错误，防止后续流程在未察觉的配置缺失状态下继续运行。
 *
 * @param name - 环境变量名称
 * @returns 该环境变量的值（string）
 * @throws Error - 当环境变量未定义或值为空字符串时
 */
function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

/**
 * 使用 DashScope（阿里云）文本嵌入 API 将一段文本转换为高维向量表示。
 * 调用 text-embedding-v4 模型，返回 1024 维浮点数向量（维度数可通过环境变量 DASHSCOPE_EMBED_DIMENSIONS 配置）。
 * 该向量可用于语义搜索、相似度计算、向量数据库索引等场景。
 *
 * @param text - 待嵌入的文本内容（可以是任意长度，建议分段以符合模型输入限制）
 * @returns Promise<number[]> - 嵌入向量，浮点数数组，长度为配置的 dimensions（默认 1024）
 * @throws Error - API 请求失败或返回格式异常时
 */
export async function embedText(text: string): Promise<number[]> {
  // 读取 DashScope API 密钥，必需
  const apiKey = getEnv("DASHSCOPE_API_KEY");

  // API 端点，可通过 DASHSCOPE_BASE_URL 自定义，默认为阿里云兼容模式地址
  const baseUrl =
    process.env.DASHSCOPE_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1";

  // 嵌入模型名称，默认 text-embedding-v4
  const model = process.env.DASHSCOPE_EMBED_MODEL ?? "text-embedding-v4";

  // 向量维度，默认 1024；需与向量数据库字段维度保持一致
  const dimensions = Number(process.env.DASHSCOPE_EMBED_DIMENSIONS ?? "1024");

  // 向 DashScope embeddings 端点发送 POST 请求
  const resp = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,          // 指定使用的嵌入模型
      input: text,    // 待嵌入的文本
      dimensions,     // 输出向量维度
      encoding_format: "float", // 返回标准浮点数格式
    }),
  });

  // 若 HTTP 状态码非 2xx，解析错误信息并抛出
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DashScope embedding failed: ${resp.status} ${errText}`);
  }

  // 解析响应体，提取 embedding 向量
  const data = (await resp.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };

  // data.data[0].embedding 为实际的向量数组，取第一个结果
  const embedding = data.data?.[0]?.embedding;

  // 防御性校验：确保向量存在且为数组类型
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("DashScope embedding response missing vector");
  }

  return embedding;
}