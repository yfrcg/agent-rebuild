
import type {
  ChatMessage,
  ModelGenerateOptions,
  ModelProvider,
  ModelResponse,
  StreamingModelProvider,
} from "./types";

export interface MockModelProviderOptions {
  prefix?: string;
}

/**
 * 一个完全离线、可重复的模型提供商。
 *
 * 主要用于本地开发、单元测试和离线门禁，
 * 避免日常验证依赖真实模型 API。
 */
export class MockModelProvider implements StreamingModelProvider {
  readonly name = "mock";
  readonly supportsStreaming = true;

  private readonly prefix: string;

  /** 构造器说明：初始化当前类依赖和内部状态，保证实例创建后可以按既定生命周期工作。 */
  constructor(options: MockModelProviderOptions = {}) {
    this.prefix = options.prefix ?? "mock response:";
  }

  /**
   * 方法 `generate` 的职责说明。
   * `generate` 承载当前模块中的一段可复用流程，调用方依赖它完成明确的业务步骤。
   * 维护时请重点关注调用边界、错误处理、状态变化和与相邻模块的契约一致性。
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
        raw: {
          messageCount: messages.length,
          streamed: true,
        },
      };
    }

    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;

    if (lastUserMessage?.includes("[AUTO_TOOL_DECISION]")) {
      return {
        text: JSON.stringify({
          action: "respond",
          reason: "Mock model does not autonomously plan tool usage.",
        }),
        raw: {
          messageCount: messages.length,
          mode: "auto-tool-decision",
        },
      };
    }

    const text = `${this.prefix} ${lastUserMessage ?? "no user message"}`.trim();

    return {
      text,
      raw: {
        messageCount: messages.length,
      },
    };
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
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;

    const text = lastUserMessage?.includes("[AUTO_TOOL_DECISION]")
      ? JSON.stringify({ action: "respond", reason: "Mock stream response." })
      : `${this.prefix} ${lastUserMessage ?? "no user message"}`.trim();

    for (let i = 0; i < text.length; i += 10) {
      throwIfAborted(options?.signal);
      yield text.slice(i, i + 10);
    }
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

export default MockModelProvider;
