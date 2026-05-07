import type {
  ChatMessage,
  ModelGenerateOptions,
  ModelResponse,
  StreamingModelProvider,
} from "./types";

export interface OpenAiCompatibleProviderConfig {
  name: string;
  displayName: string;
  apiKeyEnvNames: string[];
  baseUrlEnvName: string;
  modelEnvName: string;
  maxTokensEnvName: string;
  temperatureEnvName: string;
  timeoutMsEnvName: string;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  defaultTimeoutMs?: number;
}

export interface OpenAiCompatibleProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
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

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
}

export class OpenAiCompatibleProvider implements StreamingModelProvider {
  readonly name: string;
  readonly supportsStreaming = true;

  private readonly displayName: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly config: OpenAiCompatibleProviderConfig;

  private lastRawResponse: unknown;

  constructor(
    config: OpenAiCompatibleProviderConfig,
    options: OpenAiCompatibleProviderOptions = {}
  ) {
    this.config = config;
    this.name = config.name;
    this.displayName = config.displayName;
    this.apiKey = options.apiKey ?? this.readFirstEnv(config.apiKeyEnvNames);
    this.baseUrl = this.normalizeBaseUrl(
      options.baseUrl ??
        process.env[config.baseUrlEnvName] ??
        config.defaultBaseUrl
    );
    this.model = options.model ?? process.env[config.modelEnvName] ?? config.defaultModel;
    this.maxTokens = this.readNumberOption(
      options.maxTokens,
      config.maxTokensEnvName,
      config.defaultMaxTokens ?? 1024,
      { min: 1, max: 128_000, integer: true }
    );
    this.temperature = this.readNumberOption(
      options.temperature,
      config.temperatureEnvName,
      config.defaultTemperature ?? 0.7,
      { min: 0, max: 2 }
    );
    this.timeoutMs = this.readNumberOption(
      options.timeoutMs,
      config.timeoutMsEnvName,
      config.defaultTimeoutMs ?? 30_000,
      { min: 1000, max: 600_000 }
    );
  }

  async generate(
    messages: ChatMessage[],
    options?: ModelGenerateOptions
  ): Promise<ModelResponse> {
    if (options?.onDelta) {
      let text = "";
      for await (const delta of this.generateStream(messages, { signal: options.signal, responseFormat: options.responseFormat })) {
        throwIfAborted(options.signal);
        text += delta;
        await options.onDelta(delta);
      }
      return { text, raw: this.lastRawResponse };
    }

    const text = await this.chat(messages, { signal: options?.signal, responseFormat: options?.responseFormat });
    return { text, raw: this.lastRawResponse };
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    return this.chat(messages);
  }

  async invoke(messages: ChatMessage[]): Promise<string> {
    return this.chat(messages);
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal; responseFormat?: { type: "json_object" | "text" } }
  ): AsyncIterable<string> {
    this.assertConfig();

    const endpoint = this.resolveEndpoint(this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: this.normalizeMessages(messages),
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        stream: true,
      };
      if (options?.responseFormat) {
        body.response_format = options.responseFormat;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          this.buildHttpErrorMessage(response.status, response.statusText, errorText)
        );
      }

      if (!response.body) {
        throw new Error(`${this.displayName} streaming response body is null`);
      }

      const reader = response.body.getReader();
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
              const parsed = JSON.parse(data) as StreamChunk;
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                yield delta;
              }
            } catch {
              // Ignore malformed SSE lines from compatible providers.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        throw new Error(
          `${this.displayName} streaming request timed out after ${this.timeoutMs}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async chat(
    messages: ChatMessage[],
    options?: { signal?: AbortSignal; responseFormat?: { type: "json_object" | "text" } }
  ): Promise<string> {
    this.assertConfig();

    const endpoint = this.resolveEndpoint(this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: this.normalizeMessages(messages),
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        stream: false,
      };
      if (options?.responseFormat) {
        body.response_format = options.responseFormat;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
            `${this.displayName} response does not contain message content.`,
            `Check ${this.config.modelEnvName}, ${this.config.baseUrlEnvName}, and provider response format.`,
          ].join(" ")
        );
      }

      return content;
    } catch (err) {
      if (this.isAbortError(err)) {
        throw new Error(
          `${this.displayName} request timed out after ${this.timeoutMs}ms. Check network/proxy and ${this.config.baseUrlEnvName}.`
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
          `${this.displayName} config missing: ${this.config.apiKeyEnvNames.join(" or ")} is not set.`,
          `Add the API key to .env or pass apiKey when creating ${this.displayName}.`,
        ].join(" ")
      );
    }

    if (!this.baseUrl) {
      throw new Error(
        `${this.displayName} config missing: ${this.config.baseUrlEnvName} is empty.`
      );
    }

    if (!this.model) {
      throw new Error(
        `${this.displayName} config missing: ${this.config.modelEnvName} is empty.`
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
    const response = raw as ChatCompletionResponse | undefined;
    if (response?.error?.message) {
      throw new Error(`${this.displayName} API error: ${response.error.message}`);
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
      `${this.displayName} API request failed: ${status} ${statusText}`.trim(),
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

  private readFirstEnv(names: string[]): string | undefined {
    for (const name of names) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private readNumberEnv(
    name: string,
    fallback: number,
    opts?: { min?: number; max?: number; integer?: boolean }
  ): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const value = Number(raw);
    return this.normalizeNumber(value, fallback, opts);
  }

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

  private normalizeNumber(
    value: number,
    fallback: number,
    opts?: { min?: number; max?: number; integer?: boolean }
  ): number {
    if (!Number.isFinite(value)) return fallback;
    if (opts?.integer && !Number.isInteger(value)) return fallback;
    if (opts?.min !== undefined && value < opts.min) return fallback;
    if (opts?.max !== undefined && value > opts.max) return fallback;
    return value;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("RUN_CANCELLED");
  }
}
