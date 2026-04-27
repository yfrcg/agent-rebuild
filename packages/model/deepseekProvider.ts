import type { ChatMessage, ModelProvider, ModelResponse } from "./types";

export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

interface DeepSeekChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
    };
    text?: string;
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

export class DeepSeekProvider implements ModelProvider {
  readonly name = "deepseek";

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  private lastRawResponse: unknown;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.baseUrl = this.normalizeBaseUrl(
      options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        "https://api.deepseek.com/v1/chat/completions"
    );
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    this.maxTokens =
      options.maxTokens ?? this.readNumberEnv("DEEPSEEK_MAX_TOKENS", 1024);
    this.temperature =
      options.temperature ?? this.readNumberEnv("DEEPSEEK_TEMPERATURE", 0.7);
    this.timeoutMs =
      options.timeoutMs ?? this.readNumberEnv("DEEPSEEK_TIMEOUT_MS", 30000);
  }

  async generate(messages: ChatMessage[]): Promise<ModelResponse> {
    const text = await this.chat(messages);
    return {
      text,
      raw: this.lastRawResponse,
    };
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    return this.chat(messages);
  }

  async invoke(messages: ChatMessage[]): Promise<string> {
    return this.chat(messages);
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    this.assertConfig();

    const endpoint = this.resolveEndpoint(this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.normalizeMessages(messages),
          max_tokens: this.maxTokens,
          temperature: this.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = this.safeParseJson(rawText);

      this.lastRawResponse = parsed ?? rawText;

      if (!response.ok) {
        throw new Error(
          this.buildHttpErrorMessage(response.status, response.statusText, rawText)
        );
      }

      const content = this.extractContent(parsed);
      if (!content) {
        throw new Error(
          [
            "DeepSeek response does not contain message content.",
            "DeepSeekProvider 返回了无效响应：没有找到可用的文本内容。",
            "请检查 DEEPSEEK_MODEL、DEEPSEEK_BASE_URL 以及供应商返回格式。",
          ].join(" ")
        );
      }

      return content;
    } catch (err) {
      if (this.isAbortError(err)) {
        throw new Error(
          `DeepSeek request timed out after ${this.timeoutMs}ms. DeepSeekProvider 请求超时，请检查网络、代理或 DEEPSEEK_BASE_URL。`
        );
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  getLastRawResponse(): unknown {
    return this.lastRawResponse;
  }

  private assertConfig(): void {
    if (!this.apiKey) {
      throw new Error(
        [
          "DeepSeekProvider 配置缺失：DEEPSEEK_API_KEY 未设置。",
          "请在 .env 中配置 DEEPSEEK_API_KEY，或在创建 DeepSeekProvider 时传入 apiKey。",
        ].join(" ")
      );
    }

    if (!this.baseUrl) {
      throw new Error(
        [
          "DeepSeekProvider 配置缺失：DEEPSEEK_BASE_URL 为空。",
          "请检查 .env 或 Gateway runtime config。",
        ].join(" ")
      );
    }

    if (!this.model) {
      throw new Error(
        [
          "DeepSeekProvider 配置缺失：DEEPSEEK_MODEL 为空。",
          "请检查 .env 或 Gateway runtime config。",
        ].join(" ")
      );
    }
  }

  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => ({
      role: message.role,
      content: String(message.content ?? ""),
    }));
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, "");
  }

  private resolveEndpoint(baseUrl: string): string {
    if (baseUrl.endsWith("/chat/completions")) {
      return baseUrl;
    }

    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/chat/completions`;
    }

    return `${baseUrl}/v1/chat/completions`;
  }

  private extractContent(raw: unknown): string {
    const response = raw as DeepSeekChatCompletionResponse | undefined;

    if (response?.error?.message) {
      throw new Error(`DeepSeekProvider API 错误：${response.error.message}`);
    }

    const choice = response?.choices?.[0];
    const messageContent = choice?.message?.content;

    if (typeof messageContent === "string" && messageContent.trim()) {
      return messageContent.trim();
    }

    if (typeof choice?.text === "string" && choice.text.trim()) {
      return choice.text.trim();
    }

    return "";
  }

  private safeParseJson(rawText: string): unknown {
    try {
      return JSON.parse(rawText);
    } catch {
      return undefined;
    }
  }

  private buildHttpErrorMessage(
    status: number,
    statusText: string,
    rawText: string
  ): string {
    const clippedRaw =
      rawText.length > 800 ? `${rawText.slice(0, 800)}...[truncated]` : rawText;

    return [
      `DeepSeek API request failed: ${status} ${statusText}`.trim(),
      clippedRaw ? `response=${clippedRaw}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"))
    );
  }

  private readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];

    if (!raw) {
      return fallback;
    }

    const value = Number(raw);

    return Number.isFinite(value) ? value : fallback;
  }
}

export default DeepSeekProvider;
