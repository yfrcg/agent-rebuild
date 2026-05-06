
import type {
  ChatMessage,
  ModelGenerateOptions,
  ModelProvider,
  ModelResponse,
  StreamingModelProvider,
} from "./types";

/**
 * DeepSeek 提供商的可选构造参数。
 *
 * 所有参数都支持显式传入，若未传入则回退到环境变量或默认值。
 */
export interface DeepSeekProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * DeepSeek Chat Completion 响应的最小结构描述。
 *
 * 这里只保留本项目真正会用到的字段，避免类型定义过度膨胀。
 */
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

interface DeepSeekStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
}

/**
 * DeepSeek 模型提供商实现。
 *
 * 这个类负责把 Gateway 的统一消息协议，转换成 DeepSeek HTTP API 需要的请求格式，
 * 再把返回结果清洗成 Gateway 能消费的统一文本输出。
 */
export class DeepSeekProvider implements StreamingModelProvider {
  readonly name = "deepseek";
  readonly supportsStreaming = true;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  private lastRawResponse: unknown;

  /**
   * 初始化 DeepSeek 提供商配置。
   *
   * 优先级遵循：
   * 1. 构造参数
   * 2. 环境变量
   * 3. 内置默认值
   */
  constructor(options: DeepSeekProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.baseUrl = this.normalizeBaseUrl(
      options.baseUrl ??
        process.env.DEEPSEEK_BASE_URL ??
        "https://api.deepseek.com/v1/chat/completions"
    );
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    this.maxTokens = this.readNumberOption(
      options.maxTokens,
      "DEEPSEEK_MAX_TOKENS",
      1024,
      { min: 1, max: 128_000, integer: true }
    );
    this.temperature = this.readNumberOption(
      options.temperature,
      "DEEPSEEK_TEMPERATURE",
      0.7,
      { min: 0, max: 2 }
    );
    this.timeoutMs = this.readNumberOption(
      options.timeoutMs,
      "DEEPSEEK_TIMEOUT_MS",
      30_000,
      { min: 1000, max: 600_000 }
    );
  }

  /**
   * 以标准 `ModelResponse` 结构生成模型结果。
   *
   * 这是对外最正式的调用入口，会同时返回文本和原始响应。
   */
  async generate(
    messages: ChatMessage[],
    options?: ModelGenerateOptions
  ): Promise<ModelResponse> {
    if (options?.onDelta) {
      let text = "";
      for await (const delta of this.generateStream(messages, { signal: options.signal })) {
        throwIfAborted(options.signal);
        text += delta;
        await options.onDelta(delta);
      }
      return {
        text,
        raw: this.lastRawResponse,
      };
    }

    const text = await this.chat(messages, { signal: options?.signal });
    return {
      text,
      raw: this.lastRawResponse,
    };
  }

  /**
   * 兼容某些旧调用方使用的 `complete()` 入口。
   */
  async complete(messages: ChatMessage[]): Promise<string> {
    return this.chat(messages);
  }

  /**
   * 兼容某些旧调用方使用的 `invoke()` 入口。
   */
  async invoke(messages: ChatMessage[]): Promise<string> {
    return this.chat(messages);
  }

  /**
   * 方法 `generateStream` 的职责说明。
   * `generateStream` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  async *generateStream(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal }
  ): AsyncIterable<string> {
    this.assertConfig();

    const endpoint = this.resolveEndpoint(this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort());
    }

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
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          this.buildHttpErrorMessage(response.status, response.statusText, errorText)
        );
      }

      const body = response.body;
      if (!body) {
        throw new Error("DeepSeek streaming response body is null");
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") return;

            try {
              const parsed = JSON.parse(data) as DeepSeekStreamChunk;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                yield delta;
              }
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        throw new Error(
          `DeepSeek streaming request timed out after ${this.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 向 DeepSeek 发送聊天请求，并提取最终文本内容。
   *
   * 这里完整处理了：
   * - 配置校验
   * - 请求超时
   * - HTTP 错误
   * - JSON 解析
   * - 模型返回结构兼容
   */
  async chat(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal }
  ): Promise<string> {
    this.assertConfig();

    const endpoint = this.resolveEndpoint(this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

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
          `DeepSeek request timed out after ${this.timeoutMs}ms。DeepSeekProvider 请求超时，请检查网络、代理或 DEEPSEEK_BASE_URL。`
        );
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 获取最近一次调用保留的原始响应。
   *
   * 主要用于调试和审计。
   */
  getLastRawResponse(): unknown {
    return this.lastRawResponse;
  }

  /**
   * 校验运行所需的关键配置是否齐全。
   *
   * 缺少 API Key、Base URL 或模型名时直接抛错，
   * 让问题尽早暴露，而不是把无效请求真的打到远端。
   */
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

  /**
   * 规范化消息结构，确保每条消息 content 最终都是字符串。
   */
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => ({
      role: message.role,
      content: String(message.content ?? ""),
    }));
  }

  /**
   * 统一清理 baseUrl 尾部多余斜杠。
   */
  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, "");
  }

  /**
   * 把任意合法 baseUrl 解析成真正可请求的 chat completions 端点。
   *
   * 支持三种输入：
   * - 已经是完整 `/chat/completions`
   * - 只到 `/v1`
   * - 只到域名根路径
   */
  private resolveEndpoint(baseUrl: string): string {
    if (baseUrl.endsWith("/chat/completions")) {
      return baseUrl;
    }

    if (baseUrl.endsWith("/v1")) {
      return `${baseUrl}/chat/completions`;
    }

    return `${baseUrl}/v1/chat/completions`;
  }

  /**
   * 从 DeepSeek 原始响应中提取真正的文本内容。
   *
   * 优先读取标准的 `choices[0].message.content`，
   * 若供应商返回兼容旧格式的 `text` 字段，也能兜底兼容。
   */
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

  /**
   * 安全解析 JSON。
   *
   * 当供应商返回的并非合法 JSON 时，不抛错，
   * 让调用方仍有机会把原始文本纳入错误信息中。
   */
  private safeParseJson(rawText: string): unknown {
    try {
      return JSON.parse(rawText);
    } catch {
      return undefined;
    }
  }

  /**
   * 构造 HTTP 请求失败时的详细错误信息。
   *
   * 这里会附带截断后的响应体，方便快速定位是鉴权、限流还是参数错误。
   */
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

  /**
   * 判断一个异常是否属于超时中止。
   */
  private isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"))
    );
  }

  /**
   * 从环境变量读取数值配置，非法时回退默认值。
   */
  private readNumberEnv(
    name: string,
    fallback: number,
    opts?: { min?: number; max?: number; integer?: boolean }
  ): number {
    const raw = process.env[name];

    if (!raw) {
      return fallback;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return fallback;
    }

    if (opts?.integer && !Number.isInteger(value)) {
      return fallback;
    }
    if (opts?.min !== undefined && value < opts.min) {
      return fallback;
    }
    if (opts?.max !== undefined && value > opts.max) {
      return fallback;
    }

    return value;
  }

  /**
   * 方法 `readNumberOption` 的职责说明。
   * `readNumberOption` 负责读取配置、状态或持久化数据，并把结果整理成调用方需要的形状。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private readNumberOption(
    value: number | undefined,
    envName: string,
    fallback: number,
    opts?: { min?: number; max?: number; integer?: boolean }
  ): number {
    if (value === undefined) {
      return this.readNumberEnv(envName, fallback, opts);
    }

    return this.normalizeNumber(value, fallback, opts);
  }

  /**
   * 方法 `normalizeNumber` 的职责说明。
   * `normalizeNumber` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
   */
  private normalizeNumber(
    value: number,
    fallback: number,
    opts?: { min?: number; max?: number; integer?: boolean }
  ): number {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    if (opts?.integer && !Number.isInteger(value)) {
      return fallback;
    }
    if (opts?.min !== undefined && value < opts.min) {
      return fallback;
    }
    if (opts?.max !== undefined && value > opts.max) {
      return fallback;
    }

    return value;
  }
}

/**
 * 函数 `throwIfAborted` 的职责说明。
 * `throwIfAborted` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
 * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("RUN_CANCELLED");
  }
}

export default DeepSeekProvider;
