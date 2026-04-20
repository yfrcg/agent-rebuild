import "dotenv/config";

function getEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

export async function embedText(text: string): Promise<number[]> {
  const apiKey = getEnv("DASHSCOPE_API_KEY");
  const baseUrl =
    process.env.DASHSCOPE_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = process.env.DASHSCOPE_EMBED_MODEL ?? "text-embedding-v4";
  const dimensions = Number(process.env.DASHSCOPE_EMBED_DIMENSIONS ?? "1024");

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
